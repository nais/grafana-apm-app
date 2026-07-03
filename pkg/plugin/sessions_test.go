package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// mockSessionsDsServer serves /api/ds/query for the sessions handler: instant
// metric queries dispatch on expr substrings (resultsMap/errorsMap, like
// mockDsQueryServer), and the queryType=range log query answers with
// Time/Line frames built from logLines (or logErr).
func mockSessionsDsServer(t *testing.T, resultsMap map[string][]queries.PromResult, errorsMap map[string]string, logLines []queries.LogEntry, logErr string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Queries []struct {
				RefID     string `json:"refId"`
				Expr      string `json:"expr"`
				QueryType string `json:"queryType"`
			} `json:"queries"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Queries) == 0 {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		q := req.Queries[0]

		type frame struct {
			Schema struct {
				Fields []map[string]any `json:"fields"`
			} `json:"schema"`
			Data struct {
				Values []any `json:"values"`
			} `json:"data"`
		}
		type result struct {
			Error  string  `json:"error,omitempty"`
			Frames []frame `json:"frames"`
		}
		res := result{}
		respond := func() {
			writeMock(w, map[string]any{"results": map[string]any{q.RefID: res}})
		}

		if q.QueryType == "range" {
			if logErr != "" {
				res.Error = logErr
				respond()
				return
			}
			var f frame
			f.Schema.Fields = []map[string]any{{"name": "labels"}, {"name": "Time"}, {"name": "Line"}}
			times := make([]int64, 0, len(logLines))
			lines := make([]string, 0, len(logLines))
			for _, e := range logLines {
				times = append(times, e.TimeMs)
				lines = append(lines, e.Line)
			}
			f.Data.Values = []any{make([]any, len(logLines)), times, lines}
			res.Frames = append(res.Frames, f)
			respond()
			return
		}

		for key, msg := range errorsMap {
			if strings.Contains(q.Expr, key) {
				res.Error = msg
				respond()
				return
			}
		}
		for key, series := range resultsMap {
			if !strings.Contains(q.Expr, key) {
				continue
			}
			for _, s := range series {
				var f frame
				f.Schema.Fields = []map[string]any{
					{"name": "Time"},
					{"name": "Value", "labels": s.Metric},
				}
				f.Data.Values = []any{[]int64{0}, []float64{s.Value.Float()}}
				res.Frames = append(res.Frames, f)
			}
			break
		}
		respond()
	}))
}

func sessionsTestApp(t *testing.T, resultsMap map[string][]queries.PromResult, errorsMap map[string]string, logLines []queries.LogEntry, logErr string) (*App, *queries.DsQueryClient) {
	t.Helper()
	srv := mockSessionsDsServer(t, resultsMap, errorsMap, logLines, logErr)
	t.Cleanup(srv.Close)
	app := &App{otelCfg: otelconfig.Default()}
	ds := queries.NewDsQueryClient(srv.URL, "")
	return app, ds
}

func sessionsBySessionID(resp FrontendSessionsResponse) map[string]SessionSummary {
	m := make(map[string]SessionSummary, len(resp.Sessions))
	for _, s := range resp.Sessions {
		m[s.SessionID] = s
	}
	return m
}

func TestQueryFrontendSessionsAggregatesAndSorts(t *testing.T) {
	// Errors drive the panel (error-first entry point): s2 sorts first with
	// the most errors, then s3, then s1. Error-free sessions never appear.
	events := []queries.PromResult{
		{Metric: map[string]string{"session_id": "s1"}, Value: queries.NewPromValue(0, "12")},
		{Metric: map[string]string{"session_id": "s2"}, Value: queries.NewPromValue(0, "30")},
		{Metric: map[string]string{"session_id": "s3"}, Value: queries.NewPromValue(0, "5")},
	}
	errors := []queries.PromResult{
		{Metric: map[string]string{"session_id": "s2"}, Value: queries.NewPromValue(0, "3")},
		{Metric: map[string]string{"session_id": "s3"}, Value: queries.NewPromValue(0, "2")},
		{Metric: map[string]string{"session_id": "s1"}, Value: queries.NewPromValue(0, "1")},
	}
	logLines := []queries.LogEntry{
		{TimeMs: 5000, Line: `kind=log session_id=s3 page_url=https://x/three browser_name=Firefox browser_os="Ubuntu 24.04" app_version=v3`},
		{TimeMs: 4000, Line: `kind=exception session_id=s2 user_id=u2 user_email=bob@nav.no page_url=https://x/a browser_name=Chrome browser_os=macOS app_version=deadbeef0123`},
		{TimeMs: 3000, Line: `kind=log session_id=s2 page_url=https://x/b app_version=deadbeef0123`},
		{TimeMs: 2000, Line: `kind=log session_id=s1 user_email=alice@nav.no page_url=https://x/a`},
		{TimeMs: 1000, Line: `kind=log session_id=s2 page_url=https://x/a`},
	}
	app, ds := sessionsTestApp(t, map[string][]queries.PromResult{
		`kind="exception"`: errors,
		"session_id=(":     events, // scoped phase-2 events query
	}, nil, logLines, "")

	resp := app.queryFrontendSessions(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0), "")

	if resp.Unavailable || resp.Truncated || resp.WindowSeconds != 0 {
		t.Fatalf("unexpected response flags: %+v", resp)
	}
	if len(resp.Sessions) != 3 {
		t.Fatalf("expected 3 sessions, got %d: %+v", len(resp.Sessions), resp.Sessions)
	}
	if got := []string{resp.Sessions[0].SessionID, resp.Sessions[1].SessionID, resp.Sessions[2].SessionID}; got[0] != "s2" || got[1] != "s3" || got[2] != "s1" {
		t.Errorf("sort order = %v, want [s2 s3 s1] (errors desc)", got)
	}

	by := sessionsBySessionID(resp)
	s2 := by["s2"]
	if s2.Events != 30 || s2.Errors != 3 {
		t.Errorf("s2 counts = events %v errors %v, want 30/3", s2.Events, s2.Errors)
	}
	if s2.FirstSeenMs != 1000 || s2.LastSeenMs != 4000 {
		t.Errorf("s2 seen = %d..%d, want 1000..4000", s2.FirstSeenMs, s2.LastSeenMs)
	}
	if s2.UserID != "u2" || s2.UserEmail != "bob@nav.no" || s2.Browser != "Chrome" || s2.OS != "macOS" || s2.AppVersion != "deadbeef0123" {
		t.Errorf("s2 metadata = %+v", s2)
	}
	if s2.Pages != 2 {
		t.Errorf("s2 pages = %d, want 2 distinct URLs", s2.Pages)
	}
	if s3 := by["s3"]; s3.OS != "Ubuntu 24.04" {
		t.Errorf("s3 quoted logfmt OS = %q, want %q", s3.OS, "Ubuntu 24.04")
	}
	if s1 := by["s1"]; s1.UserEmail != "alice@nav.no" || s1.Errors != 1 || s1.Pages != 1 {
		t.Errorf("s1 = %+v", s1)
	}
}

func TestQueryFrontendSessionsFiltersByQuery(t *testing.T) {
	events := []queries.PromResult{
		{Metric: map[string]string{"session_id": "abc123"}, Value: queries.NewPromValue(0, "2")},
		{Metric: map[string]string{"session_id": "def456"}, Value: queries.NewPromValue(0, "4")},
	}
	logLines := []queries.LogEntry{
		{TimeMs: 2000, Line: `session_id=abc123 user_email=Alice@Nav.no`},
		{TimeMs: 1000, Line: `session_id=def456 user_id=u-77`},
	}
	errors := []queries.PromResult{
		{Metric: map[string]string{"session_id": "abc123"}, Value: queries.NewPromValue(0, "5")},
		{Metric: map[string]string{"session_id": "def456"}, Value: queries.NewPromValue(0, "3")},
	}
	app, ds := sessionsTestApp(t, map[string][]queries.PromResult{
		`kind="exception"`: errors,
		"session_id=(":     events,
	}, nil, logLines, "")

	for _, tc := range []struct {
		q    string
		want string
	}{
		{"ALICE", "abc123"},   // user email, case-insensitive
		{"def4", "def456"},    // session id substring
		{"u-77", "def456"},    // user id
		{"nowhere-man", ""},   // no match
		{"", "abc123,def456"}, // empty query keeps everything
	} {
		resp := app.queryFrontendSessions(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0), tc.q)
		var got []string
		for _, s := range resp.Sessions {
			got = append(got, s.SessionID)
		}
		if joined := strings.Join(got, ","); joined != tc.want {
			t.Errorf("q=%q → sessions %q, want %q", tc.q, joined, tc.want)
		}
	}
}

func TestQueryFrontendSessionsWindowFallback(t *testing.T) {
	// The full-range errors query blows Loki's series limit; the 1h fallback
	// succeeds and the response reports the narrowed window. Phase-2 queries
	// then run over that same window (coherent columns by construction).
	errors := []queries.PromResult{
		{Metric: map[string]string{"session_id": "s1"}, Value: queries.NewPromValue(0, "2")},
	}
	events := []queries.PromResult{
		{Metric: map[string]string{"session_id": "s1"}, Value: queries.NewPromValue(0, "9")},
	}
	app, ds := sessionsTestApp(t,
		map[string][]queries.PromResult{`kind="exception"`: errors, "session_id=(": events},
		map[string]string{`keep session_id [86400s]`: "maximum number of series (5000) reached for a single query"},
		nil, "")

	to := time.Unix(200000, 0)
	resp := app.queryFrontendSessions(context.Background(), ds, "loki-uid", "my-app", "", to.Add(-24*time.Hour), to, "")

	if resp.Unavailable {
		t.Fatal("sessions should be available via the fallback window")
	}
	if resp.WindowSeconds != 3600 {
		t.Errorf("windowSeconds = %d, want 3600", resp.WindowSeconds)
	}
	if len(resp.Sessions) != 1 || resp.Sessions[0].Events != 9 {
		t.Errorf("unexpected sessions: %+v", resp.Sessions)
	}
}

func TestQueryFrontendSessionsUnavailableWhenEventsFail(t *testing.T) {
	// Every rung of the errors ladder fails → unavailable, no misleading zeros.
	app, ds := sessionsTestApp(t, nil,
		map[string]string{`keep session_id`: "maximum number of series (5000) reached for a single query"},
		nil, "")

	to := time.Unix(200000, 0)
	resp := app.queryFrontendSessions(context.Background(), ds, "loki-uid", "my-app", "", to.Add(-24*time.Hour), to, "")

	if !resp.Unavailable {
		t.Error("expected unavailable when the events query fails on every window")
	}
	if len(resp.Sessions) != 0 {
		t.Errorf("expected no sessions, got %+v", resp.Sessions)
	}
}

func TestQueryFrontendSessionsDegradesWithoutMetadata(t *testing.T) {
	// The raw metadata query failing must not take the list down: counts
	// still render, metadata fields stay empty.
	errors := []queries.PromResult{
		{Metric: map[string]string{"session_id": "s1"}, Value: queries.NewPromValue(0, "2")},
	}
	events := []queries.PromResult{
		{Metric: map[string]string{"session_id": "s1"}, Value: queries.NewPromValue(0, "7")},
	}
	app, ds := sessionsTestApp(t,
		map[string][]queries.PromResult{`kind="exception"`: errors, "session_id=(": events},
		nil, nil, "query too complex")

	resp := app.queryFrontendSessions(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0), "")

	if resp.Unavailable {
		t.Fatal("metadata failure must not mark the response unavailable")
	}
	if len(resp.Sessions) != 1 {
		t.Fatalf("expected 1 session, got %+v", resp.Sessions)
	}
	s := resp.Sessions[0]
	if s.Events != 7 || s.UserEmail != "" || s.LastSeenMs != 0 || s.Pages != 0 {
		t.Errorf("unexpected degraded session: %+v", s)
	}
}

func TestQueryFrontendSessionsTruncates(t *testing.T) {
	events := make([]queries.PromResult, 0, maxSessions+10)
	for i := 0; i < maxSessions+10; i++ {
		events = append(events, queries.PromResult{
			Metric: map[string]string{"session_id": strings.Repeat("x", 3) + string(rune('a'+i%26)) + string(rune('a'+i/26))},
			Value:  queries.NewPromValue(0, "1"),
		})
	}
	app, ds := sessionsTestApp(t, map[string][]queries.PromResult{
		`kind="exception"`: events, // reused as the errors fixture
	}, nil, nil, "")

	resp := app.queryFrontendSessions(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0), "")

	if !resp.Truncated {
		t.Error("expected truncated response")
	}
	if len(resp.Sessions) != maxSessions {
		t.Errorf("len(sessions) = %d, want %d", len(resp.Sessions), maxSessions)
	}
}

func TestParseLogfmt(t *testing.T) {
	got := parseLogfmt(`kind=log session_id=abc user_email="Bob \"The Builder\" <bob@nav.no>" browser_os="macOS 14" empty= trailing`)
	want := map[string]string{
		"kind":       "log",
		"session_id": "abc",
		"user_email": `Bob "The Builder" <bob@nav.no>`,
		"browser_os": "macOS 14",
		"empty":      "",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("parseLogfmt[%q] = %q, want %q", k, got[k], v)
		}
	}
	if _, ok := got["trailing"]; ok {
		t.Error("bare token without '=' must not become a field")
	}
}
