package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
)

// patternsTestApp builds an App wired to a single fake Grafana that serves both
// the Loki patterns proxy path and /api/ds/query (for the sampled fallback).
func patternsTestApp(t *testing.T, srv *httptest.Server) *App {
	t.Helper()
	t.Cleanup(srv.Close)
	return &App{
		otelCfg:      otelconfig.Default(),
		grafanaURL:   srv.URL,
		healthClient: &http.Client{Timeout: 5 * time.Second},
	}
}

// mockPatternsServer serves the Loki pattern-ingester proxy endpoint. It keys
// the response on the `start` query param so the current and previous windows
// can return different pattern sets (to exercise the isNew flag). A start below
// prevBelow returns prevData; otherwise curData. When status != 200 it errors
// (to exercise the sampled fallback). logsFrame, if set, answers /api/ds/query
// range queries with those lines.
type patternDoc struct {
	pattern string
	level   string
	samples [][2]float64
}

func mockPatternsServer(t *testing.T, status int, curData, prevData []patternDoc, prevBelow int64, logLines []string) *httptest.Server {
	t.Helper()
	writePatterns := func(w http.ResponseWriter, docs []patternDoc) {
		type doc struct {
			Pattern string       `json:"pattern"`
			Level   string       `json:"level"`
			Samples [][2]float64 `json:"samples"`
		}
		out := make([]doc, 0, len(docs))
		for _, d := range docs {
			out = append(out, doc{Pattern: d.pattern, Level: d.level, Samples: d.samples})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": out})
	}

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/api/ds/query") {
			var req struct {
				Queries []struct {
					RefID string `json:"refId"`
				} `json:"queries"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			times := make([]int64, len(logLines))
			for i := range times {
				times[i] = int64(1000 + i)
			}
			frame := map[string]any{
				"schema": map[string]any{"fields": []map[string]any{{"name": "Time"}, {"name": "Line"}}},
				"data":   map[string]any{"values": []any{times, logLines}},
			}
			writeMock(w, map[string]any{"results": map[string]any{"A": map[string]any{"frames": []any{frame}}}})
			return
		}
		if !strings.Contains(r.URL.Path, "/loki/api/v1/patterns") {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if status != http.StatusOK {
			http.Error(w, "boom", status)
			return
		}
		start, _ := strconv.ParseInt(r.URL.Query().Get("start"), 10, 64)
		if start < prevBelow {
			writePatterns(w, prevData)
			return
		}
		writePatterns(w, curData)
	}))
}

func TestQueryLogPatternsServerMode(t *testing.T) {
	// Current window: two error patterns (P1 higher count) plus an info pattern
	// that must be filtered out. Previous window: only P1 → P2 is new.
	cur := []patternDoc{
		{"Failed to load søknad <_>", "error", [][2]float64{{1500, 5}, {1600, 0}, {1700, 3}}},
		{"Timeout calling upstream <_>", "error", [][2]float64{{1550, 40}}},
		{"Healthy heartbeat <_>", "info", [][2]float64{{1500, 999}}},
	}
	prev := []patternDoc{
		{"Failed to load søknad <_>", "error", [][2]float64{{500, 2}}},
	}
	// from=1000,to=2000 → current start=1000; prev window start=0. prevBelow=1000.
	srv := mockPatternsServer(t, http.StatusOK, cur, prev, 1000, nil)
	app := patternsTestApp(t, srv)

	resp := app.queryLogPatterns(context.Background(), http.Header{}, "nav-logs", "my-svc", time.Unix(1000, 0), time.Unix(2000, 0))

	if resp.Mode != "serverPatterns" {
		t.Fatalf("mode = %q, want serverPatterns", resp.Mode)
	}
	if len(resp.Patterns) != 2 {
		t.Fatalf("expected 2 error patterns (info filtered), got %d: %+v", len(resp.Patterns), resp.Patterns)
	}
	// Sorted by count desc: "Timeout..." (40) before "Failed..." (8).
	first := resp.Patterns[0]
	if !strings.HasPrefix(first.Pattern, "Timeout") {
		t.Errorf("top pattern = %q, want Timeout first (count desc)", first.Pattern)
	}
	if first.Count != 40 {
		t.Errorf("Timeout count = %d, want 40", first.Count)
	}
	if !first.IsNew {
		t.Errorf("Timeout should be flagged new (absent in previous window)")
	}
	if first.FilterLiteral != "Timeout" && first.FilterLiteral != "upstream" && first.FilterLiteral != "calling" {
		t.Errorf("unexpected filterLiteral %q", first.FilterLiteral)
	}
	failed := resp.Patterns[1]
	if failed.Count != 8 {
		t.Errorf("Failed count = %d, want 8 (5+3, empty bucket skipped)", failed.Count)
	}
	if failed.IsNew {
		t.Errorf("Failed pattern present in previous window must not be new")
	}
	if failed.FirstSeenMs != 1500000 || failed.LastSeenMs != 1700000 {
		t.Errorf("Failed seen = %d..%d, want 1500000..1700000", failed.FirstSeenMs, failed.LastSeenMs)
	}
}

func TestQueryLogPatternsSampledFallback(t *testing.T) {
	// Pattern ingester 500s → sampled fallback clusters raw lines by Normalize.
	lines := []string{
		"Invalid søknad 12345 rejected",
		"Invalid søknad 67890 rejected",
		"Connection refused to db-host",
	}
	srv := mockPatternsServer(t, http.StatusInternalServerError, nil, nil, 0, lines)
	app := patternsTestApp(t, srv)

	resp := app.queryLogPatterns(context.Background(), http.Header{}, "nav-logs", "my-svc", time.Unix(1000, 0), time.Unix(2000, 0))

	if resp.Mode != "sampled" {
		t.Fatalf("mode = %q, want sampled", resp.Mode)
	}
	// The two "Invalid søknad <num> rejected" lines normalize to one cluster.
	if len(resp.Patterns) != 2 {
		t.Fatalf("expected 2 clusters, got %d: %+v", len(resp.Patterns), resp.Patterns)
	}
	top := resp.Patterns[0]
	if top.Count != 2 {
		t.Errorf("top cluster count = %d, want 2", top.Count)
	}
	if !strings.Contains(top.Pattern, "<num>") {
		t.Errorf("top cluster pattern = %q, want a <num> placeholder", top.Pattern)
	}
	if top.Sample == "" {
		t.Errorf("sampled mode should carry a representative sample line")
	}
}

func TestSanitizeDatasourceUID(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"nav-logs", "nav-logs"},
		{"P1234_abc-XYZ", "P1234_abc-XYZ"},
		{"", ""},
		{"bad uid", ""},
		{"../../etc", ""},
		{"a/b", ""},
		{strings.Repeat("a", 65), ""},
	}
	for _, tc := range tests {
		if got := sanitizeDatasourceUID(tc.in); got != tc.want {
			t.Errorf("sanitizeDatasourceUID(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestLongestLiteral(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"Failed under påminnelse av sak <_>", "påminnelse"},
		{"<_> tilbakekrevingId=<_>", "tilbakekrevingId"},
		{"a bc de <_>", ""}, // nothing ≥4 runes
		{"Timeout calling <_>", "Timeout"},
	}
	for _, tc := range tests {
		if got := longestLiteral(tc.in); got != tc.want {
			t.Errorf("longestLiteral(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestServerPatternsIsNewNeedsBaseline(t *testing.T) {
	// Regression (data-review P-1): when the previous window predates the
	// pattern ingester's retention it returns EMPTY — that means "no
	// baseline", not "everything is new". Chronic patterns were all NEW.
	cur := []patternDoc{
		{"Chronic failure <_>", "error", [][2]float64{{1500, 40000}}},
		{"Other failure <_>", "error", [][2]float64{{1550, 17000}}},
	}
	srv := mockPatternsServer(t, http.StatusOK, cur, []patternDoc{}, 1000, nil)
	app := patternsTestApp(t, srv)

	resp := app.queryLogPatterns(context.Background(), http.Header{}, "nav-logs", "my-svc", time.Unix(1000, 0), time.Unix(2000, 0))

	if resp.Mode != "serverPatterns" || len(resp.Patterns) != 2 {
		t.Fatalf("unexpected response: mode=%s patterns=%d", resp.Mode, len(resp.Patterns))
	}
	for _, p := range resp.Patterns {
		if p.IsNew {
			t.Errorf("pattern %q flagged new with an empty baseline window", p.Pattern)
		}
	}
}
