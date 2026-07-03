package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/fingerprint"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// mockDsQueryServer serves Grafana's /api/ds/query contract: it matches the
// posted expr against resultsMap substrings and answers with instant-vector
// data frames (one frame per series, labels on the value field). Exprs
// matching an errorsMap key answer with a per-refId error instead.
func mockDsQueryServer(t *testing.T, resultsMap map[string][]queries.PromResult, errorsMap map[string]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Queries []struct {
				RefID string `json:"refId"`
				Expr  string `json:"expr"`
			} `json:"queries"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Queries) == 0 {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		expr := req.Queries[0].Expr

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

		for key, msg := range errorsMap {
			if strings.Contains(expr, key) {
				res.Error = msg
				writeMock(w, map[string]any{"results": map[string]any{req.Queries[0].RefID: res}})
				return
			}
		}
		for key, series := range resultsMap {
			if !strings.Contains(expr, key) {
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
		writeMock(w, map[string]any{"results": map[string]any{req.Queries[0].RefID: res}})
	}))
}

func writeMock(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func exceptionsTestApp(t *testing.T, resultsMap map[string][]queries.PromResult, errorsMap map[string]string) (*App, *queries.DsQueryClient) {
	t.Helper()
	srv := mockDsQueryServer(t, resultsMap, errorsMap)
	t.Cleanup(srv.Close)
	app := &App{otelCfg: otelconfig.Default()}
	ds := queries.NewDsQueryClient(srv.URL, "")
	return app, ds
}

func TestQueryExceptionGroupsMergesDynamicMessages(t *testing.T) {
	// Two upstream hash groups whose messages differ only by a UUID must merge
	// into one fingerprint group; a different exception type stays separate.
	counts := []queries.PromResult{
		{Metric: map[string]string{"hash": "111", "type": "Error", "value": "Invalid søknad 8f3a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8"}, Value: queries.NewPromValue(0, "10")},
		{Metric: map[string]string{"hash": "222", "type": "Error", "value": "Invalid søknad 91bb0000-1111-2222-3333-444455556666"}, Value: queries.NewPromValue(0, "5")},
		{Metric: map[string]string{"hash": "333", "type": "TypeError", "value": "t.map is not a function"}, Value: queries.NewPromValue(0, "3")},
	}
	sessions := []queries.PromResult{
		{Metric: map[string]string{"hash": "111"}, Value: queries.NewPromValue(0, "4")},
		{Metric: map[string]string{"hash": "222"}, Value: queries.NewPromValue(0, "2")},
		{Metric: map[string]string{"hash": "333"}, Value: queries.NewPromValue(0, "1")},
	}
	app, ds := exceptionsTestApp(t, map[string][]queries.PromResult{
		"sum by":   counts,
		"count by": sessions,
	}, nil)

	resp := app.queryExceptionGroups(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(1000, 0), time.Unix(4600, 0))

	if resp.FingerprintVersion != fingerprint.Version {
		t.Errorf("fingerprintVersion = %q", resp.FingerprintVersion)
	}
	if len(resp.Groups) != 2 {
		t.Fatalf("expected 2 groups, got %d: %+v", len(resp.Groups), resp.Groups)
	}

	merged := resp.Groups[0] // sorted by count desc → the merged group (15) first
	if merged.Count != 15 {
		t.Errorf("merged count = %v, want 15", merged.Count)
	}
	if merged.Sessions != 6 {
		t.Errorf("merged sessions = %v, want 6", merged.Sessions)
	}
	if len(merged.MemberHashes) != 2 {
		t.Errorf("memberHashes = %v, want [111 222]", merged.MemberHashes)
	}
	if merged.Title != "Error: Invalid søknad <uuid>" {
		t.Errorf("title = %q", merged.Title)
	}
	if merged.Tier != int(fingerprint.TierTypeMessage) {
		t.Errorf("tier = %d", merged.Tier)
	}

	single := resp.Groups[1]
	if single.Count != 3 || len(single.MemberHashes) != 1 || single.MemberHashes[0] != "333" {
		t.Errorf("unexpected single group: %+v", single)
	}
}

func TestQueryExceptionGroupsHashPassthrough(t *testing.T) {
	// Events with no value fall back to the upstream hash tier and never merge.
	counts := []queries.PromResult{
		{Metric: map[string]string{"hash": "444"}, Value: queries.NewPromValue(0, "7")},
	}
	app, ds := exceptionsTestApp(t, map[string][]queries.PromResult{"sum by": counts}, nil)

	resp := app.queryExceptionGroups(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(60, 0))

	if len(resp.Groups) != 1 {
		t.Fatalf("expected 1 group, got %d", len(resp.Groups))
	}
	g := resp.Groups[0]
	if g.Tier != int(fingerprint.TierUpstreamHash) {
		t.Errorf("tier = %d, want %d", g.Tier, fingerprint.TierUpstreamHash)
	}
	if g.Title != "Unknown exception" {
		t.Errorf("title = %q", g.Title)
	}
}

func TestLokiWindow(t *testing.T) {
	if got := lokiWindow(time.Unix(0, 0), time.Unix(3600, 0)); got != "[3600s]" {
		t.Errorf("lokiWindow(1h) = %q", got)
	}
	if got := lokiWindow(time.Unix(0, 0), time.Unix(10, 0)); got != "[60s]" {
		t.Errorf("lokiWindow(10s) = %q, want floor 60s", got)
	}
}

func TestQueryExceptionGroupsSessionsFallbackWindow(t *testing.T) {
	// Wide ranges can blow Loki's max_query_series on the (hash × session_id)
	// series set. The full-range sessions query fails; the 1h fallback window
	// succeeds; the response reports the narrowed window instead of zeros.
	counts := []queries.PromResult{
		{Metric: map[string]string{"hash": "111", "type": "Error", "value": "boom"}, Value: queries.NewPromValue(0, "100")},
	}
	sessions := []queries.PromResult{
		{Metric: map[string]string{"hash": "111"}, Value: queries.NewPromValue(0, "42")},
	}
	// The full-range window is [86400s]; only that expr errors.
	app, ds := exceptionsTestApp(t,
		map[string][]queries.PromResult{"sum by": counts, "count by": sessions},
		map[string]string{"session_id [86400s]": "maximum number of series (5000) reached for a single query"},
	)

	to := time.Unix(200000, 0)
	resp := app.queryExceptionGroups(context.Background(), ds, "loki-uid", "my-app", "", to.Add(-24*time.Hour), to)

	if resp.SessionsUnavailable {
		t.Fatal("sessions should be available via the fallback window")
	}
	if resp.SessionsWindowSeconds != 3600 {
		t.Errorf("sessionsWindowSeconds = %d, want 3600", resp.SessionsWindowSeconds)
	}
	if len(resp.Groups) != 1 || resp.Groups[0].Sessions != 42 {
		t.Errorf("unexpected groups: %+v", resp.Groups)
	}
}

func TestQueryExceptionGroupsSessionsUnavailable(t *testing.T) {
	// Both the full-range and fallback sessions queries fail → the response
	// says so instead of reporting misleading zeros.
	counts := []queries.PromResult{
		{Metric: map[string]string{"hash": "111", "type": "Error", "value": "boom"}, Value: queries.NewPromValue(0, "100")},
	}
	app, ds := exceptionsTestApp(t,
		map[string][]queries.PromResult{"sum by": counts},
		map[string]string{"count by": "maximum number of series (5000) reached for a single query"},
	)

	to := time.Unix(200000, 0)
	resp := app.queryExceptionGroups(context.Background(), ds, "loki-uid", "my-app", "", to.Add(-24*time.Hour), to)

	if !resp.SessionsUnavailable {
		t.Error("expected sessionsUnavailable")
	}
	if resp.SessionsWindowSeconds != 0 {
		t.Errorf("sessionsWindowSeconds = %d, want 0", resp.SessionsWindowSeconds)
	}
}
