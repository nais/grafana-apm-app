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

// mockFeedbackDsServer serves /api/ds/query for the feedback handler: every
// request is a queryType=range log query, answered from logLines (or
// logErr). The last received expr is captured into lastExpr so tests can
// assert on the LogQL filters the handler builds.
func mockFeedbackDsServer(t *testing.T, logLines []queries.LogEntry, logErr string, lastExpr *string) *httptest.Server {
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
		if lastExpr != nil {
			*lastExpr = req.Queries[0].Expr
		}

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
		if logErr != "" {
			res.Error = logErr
			writeMock(w, map[string]any{"results": map[string]any{req.Queries[0].RefID: res}})
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
		writeMock(w, map[string]any{"results": map[string]any{req.Queries[0].RefID: res}})
	}))
}

func feedbackTestApp(t *testing.T, logLines []queries.LogEntry, logErr string) (*App, *queries.DsQueryClient, *string) {
	t.Helper()
	var lastExpr string
	srv := mockFeedbackDsServer(t, logLines, logErr, &lastExpr)
	t.Cleanup(srv.Close)
	app := &App{otelCfg: otelconfig.Default()}
	ds := queries.NewDsQueryClient(srv.URL, "")
	return app, ds, &lastExpr
}

func TestFeedbackQueryParsesSortsNewestFirst(t *testing.T) {
	logLines := []queries.LogEntry{
		{TimeMs: 1000, Line: `kind=event event_name=faro.feedback event_data_message="old feedback" event_data_category=bug session_id=s1 app_version=v1`},
		{TimeMs: 3000, Line: `kind=event event_name=faro.feedback event_data_message="newest feedback" event_data_category=idea event_data_email=ola@nav.no session_id=s2 event_data_fingerprint=v1:abc page_url=https://x/a app_version=v2`},
		{TimeMs: 2000, Line: `kind=event event_name=faro.feedback event_data_message="middle feedback" event_data_category=other session_id=s1`},
	}
	app, ds, _ := feedbackTestApp(t, logLines, "")

	resp := app.queryFeedback(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0), "", "")

	if resp.Unavailable {
		t.Fatal("expected an available response")
	}
	if len(resp.Feedback) != 3 {
		t.Fatalf("expected 3 feedback entries, got %d: %+v", len(resp.Feedback), resp.Feedback)
	}
	if got := []int64{resp.Feedback[0].TimeMs, resp.Feedback[1].TimeMs, resp.Feedback[2].TimeMs}; got[0] != 3000 || got[1] != 2000 || got[2] != 1000 {
		t.Errorf("timeMs order = %v, want [3000 2000 1000] (newest first)", got)
	}

	f0 := resp.Feedback[0]
	if f0.Message != "newest feedback" || f0.Category != "idea" || f0.Email != "ola@nav.no" ||
		f0.SessionID != "s2" || f0.Fingerprint != "v1:abc" || f0.PageURL != "https://x/a" || f0.AppVersion != "v2" {
		t.Errorf("unexpected fields on newest entry: %+v", f0)
	}
	if f2 := resp.Feedback[2]; f2.Message != "old feedback" || f2.Category != "bug" || f2.Email != "" {
		t.Errorf("unexpected fields on oldest entry: %+v", f2)
	}
}

func TestFeedbackQueryFiltersBySessionAndFingerprint(t *testing.T) {
	app, ds, lastExpr := feedbackTestApp(t, nil, "")

	app.queryFeedback(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0), `s1"; {evil}`, `v1:abc"; DROP`)

	// Both filters are sanitized (quotes/semicolons/braces/spaces stripped)
	// before landing in the LogQL expr — session ids never carry ':', so it
	// is stripped there too, but the fingerprint sanitizer keeps it.
	if !strings.Contains(*lastExpr, `session_id="s1evil"`) {
		t.Errorf("expected a sanitized session_id filter in the expr, got %q", *lastExpr)
	}
	if !strings.Contains(*lastExpr, `event_data_fingerprint="v1:abcDROP"`) {
		t.Errorf("expected a sanitized fingerprint filter in the expr, got %q", *lastExpr)
	}
}

func TestFeedbackQueryNoFiltersWhenParamsEmpty(t *testing.T) {
	app, ds, lastExpr := feedbackTestApp(t, nil, "")

	app.queryFeedback(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0), "", "")

	if strings.Contains(*lastExpr, "session_id=") || strings.Contains(*lastExpr, "fingerprint=") {
		t.Errorf("expected no session/fingerprint filter in the expr, got %q", *lastExpr)
	}
	if !strings.Contains(*lastExpr, `event_name="faro.feedback"`) {
		t.Errorf("expected the event_name filter in the expr, got %q", *lastExpr)
	}
}

func TestFeedbackQueryUnavailableOnError(t *testing.T) {
	app, ds, _ := feedbackTestApp(t, nil, "query too complex")

	resp := app.queryFeedback(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0), "", "")

	if !resp.Unavailable {
		t.Error("expected unavailable when the log query fails")
	}
	if len(resp.Feedback) != 0 {
		t.Errorf("expected no feedback entries, got %+v", resp.Feedback)
	}
}

func TestFeedbackQueryTruncatesTo200(t *testing.T) {
	logLines := make([]queries.LogEntry, 0, maxFeedback+10)
	for i := 0; i < maxFeedback+10; i++ {
		logLines = append(logLines, queries.LogEntry{
			TimeMs: int64(i),
			Line:   `kind=event event_name=faro.feedback event_data_message="x" event_data_category=other`,
		})
	}
	app, ds, _ := feedbackTestApp(t, logLines, "")

	resp := app.queryFeedback(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0), "", "")

	if len(resp.Feedback) != maxFeedback {
		t.Fatalf("len(feedback) = %d, want %d", len(resp.Feedback), maxFeedback)
	}
	if resp.Feedback[0].TimeMs != int64(maxFeedback+9) {
		t.Errorf("expected the newest entry to survive truncation, got TimeMs=%d", resp.Feedback[0].TimeMs)
	}
}

func TestFeedbackSanitizeFingerprintFilter(t *testing.T) {
	got := sanitizeFingerprintFilter(`v1:9f2ab31c04d7e655"; DROP TABLE`)
	want := `v1:9f2ab31c04d7e655DROPTABLE`
	if got != want {
		t.Errorf("sanitizeFingerprintFilter() = %q, want %q", got, want)
	}
}

func TestFeedbackHandleUnavailableWithoutLoki(t *testing.T) {
	app := &App{otelCfg: otelconfig.Default(), respCache: newResponseCache(30*time.Second, 200)}
	mux := http.NewServeMux()
	app.registerRoutes(mux)

	req := httptest.NewRequest(http.MethodGet, "/services/_/my-app/feedback", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	var resp FeedbackResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !resp.Unavailable {
		t.Error("expected an unavailable response when no Loki datasource is configured")
	}
	if len(resp.Feedback) != 0 {
		t.Errorf("expected no feedback entries, got %+v", resp.Feedback)
	}
}

func TestFeedbackHandleMethodNotAllowed(t *testing.T) {
	app := &App{otelCfg: otelconfig.Default(), respCache: newResponseCache(30*time.Second, 200)}
	mux := http.NewServeMux()
	app.registerRoutes(mux)

	req := httptest.NewRequest(http.MethodPost, "/services/_/my-app/feedback", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", rr.Code, http.StatusMethodNotAllowed)
	}
}

func TestFeedbackHandleMissingService(t *testing.T) {
	app := &App{otelCfg: otelconfig.Default(), respCache: newResponseCache(30*time.Second, 200)}
	mux := http.NewServeMux()
	app.registerRoutes(mux)

	// "<>" fails queries.MustSanitizeLabel's safe-label regex outright and
	// sanitizes down to "", so the {service} path segment is present (unlike
	// an empty segment, which net/http's ServeMux would redirect via 301)
	// but requireServiceParam still rejects it.
	req := httptest.NewRequest(http.MethodGet, "/services/_/%3C%3E/feedback", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d for an invalid service segment", rr.Code, http.StatusBadRequest)
	}
}
