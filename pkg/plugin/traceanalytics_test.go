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

func resetTraceDimsCache() {
	traceDimsMu.Lock()
	traceDimsCache = map[string]traceDimsCacheEntry{}
	traceDimsMu.Unlock()
}

// tempoFake is one returned series: unquoted group-by labels + raw bucket values
// (the fake re-quotes label values to mimic Tempo's wire format).
type tempoFake struct {
	labels  map[string]string
	buckets []float64
}

// extractByAttr returns the first attribute inside a `by (attr[, ...])` clause.
func extractByAttr(q string) string {
	i := strings.Index(q, "by (")
	if i < 0 {
		return ""
	}
	rest := q[i+len("by ("):]
	for j, r := range rest {
		if r == ',' || r == ')' {
			return strings.TrimSpace(rest[:j])
		}
	}
	return strings.TrimSpace(rest)
}

// mockTempoServer serves /api/ds/query for TraceQL metrics. It routes on the
// query text: quantile queries return p95/p99, `by (attr, status)` returns
// rate-with-status, and bare `by (attr)` answers a detection probe.
func mockTempoServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Queries []struct {
				Query string `json:"query"`
			} `json:"queries"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Queries) == 0 {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		q := req.Queries[0].Query
		attr := extractByAttr(q)

		var series []tempoFake
		switch {
		case strings.Contains(q, "quantile_over_time(duration, .95)"):
			if attr == "name" {
				series = []tempoFake{
					{map[string]string{"name": "GET /a", "p": "0.95"}, []float64{0.05, 0.05}},
					{map[string]string{"name": "POST /b", "p": "0.95"}, []float64{0.20, 0.20}},
				}
			}
		case strings.Contains(q, "quantile_over_time(duration, .99)"):
			if attr == "name" {
				series = []tempoFake{
					{map[string]string{"name": "GET /a", "p": "0.99"}, []float64{0.06, 0.06}},
					{map[string]string{"name": "POST /b", "p": "0.99"}, []float64{0.25, 0.25}},
				}
			}
		case strings.Contains(q, ", status)"):
			if attr == "name" {
				series = []tempoFake{
					{map[string]string{"name": "GET /a", "status": "unset"}, []float64{2, 2}},
					{map[string]string{"name": "GET /a", "status": "error"}, []float64{1, 1}},
					{map[string]string{"name": "POST /b", "status": "unset"}, []float64{4, 4}},
				}
			}
		default: // detection probe: rate() by (attr)
			switch attr {
			case "name":
				series = []tempoFake{{map[string]string{"name": "GET /a"}, []float64{3, 3}}}
			case "span.db.system":
				series = []tempoFake{{map[string]string{"span.db.system": "postgresql"}, []float64{1, 1}}}
			default:
				// HTTP/other semconv attrs are nil fleet-wide.
				series = []tempoFake{{map[string]string{attr: "nil"}, []float64{5, 5}}}
			}
		}
		writeTempoFrames(w, series)
	}))
}

// writeTempoFrames encodes series as Tempo-shaped ds/query frames: a time field
// plus one value field per series carrying quoted group-by labels.
func writeTempoFrames(w http.ResponseWriter, series []tempoFake) {
	frames := make([]any, 0, len(series))
	for _, s := range series {
		quoted := make(map[string]string, len(s.labels))
		for k, v := range s.labels {
			quoted[k] = `"` + v + `"`
		}
		times := make([]int64, len(s.buckets))
		for i := range times {
			times[i] = int64(1000 + i)
		}
		frames = append(frames, map[string]any{
			"schema": map[string]any{"fields": []map[string]any{
				{"name": "time"},
				{"name": "value", "labels": quoted},
			}},
			"data": map[string]any{"values": []any{times, s.buckets}},
		})
	}
	writeMock(w, map[string]any{"results": map[string]any{"A": map[string]any{"frames": frames}}})
}

func TestQueryTraceBreakdownTraceQLMode(t *testing.T) {
	resetTraceDimsCache()
	srv := mockTempoServer(t)
	t.Cleanup(srv.Close)
	app := &App{otelCfg: otelconfig.Default(), grafanaURL: srv.URL}

	resp := app.queryTraceBreakdown(context.Background(), http.Header{}, "prod-tempo", "", "my-svc", "name", time.Unix(1000, 0), time.Unix(4600, 0))

	if resp.Mode != "traceql" {
		t.Fatalf("mode = %q, want traceql", resp.Mode)
	}
	// Available dimensions: name + db.system; HTTP/rpc/messaging are nil.
	if got := strings.Join(resp.Dimensions, ","); got != "name,db.system" {
		t.Errorf("dimensions = %q, want name,db.system", got)
	}
	if len(resp.Rows) != 2 {
		t.Fatalf("expected 2 rows, got %d: %+v", len(resp.Rows), resp.Rows)
	}
	// Sorted p99 desc: POST /b (250ms) before GET /a (60ms).
	if resp.Rows[0].Value != "POST /b" || resp.Rows[1].Value != "GET /a" {
		t.Errorf("row order = [%s,%s], want [POST /b, GET /a]", resp.Rows[0].Value, resp.Rows[1].Value)
	}
	post := resp.Rows[0]
	if post.Rate != 4 || post.ErrorRate != 0 || post.P95Ms != 200 || post.P99Ms != 250 {
		t.Errorf("POST /b = %+v, want rate 4, err 0, p95 200, p99 250", post)
	}
	get := resp.Rows[1]
	// rate = unset 2 + error 1 = 3; errorRate = 100*1/3 = 33.3.
	if get.Rate != 3 || get.ErrorRate != 33.3 || get.P95Ms != 50 || get.P99Ms != 60 {
		t.Errorf("GET /a = %+v, want rate 3, err 33.3, p95 50, p99 60", get)
	}
}

func TestDetectTraceDimensionsAllFail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	t.Cleanup(srv.Close)
	app := &App{otelCfg: otelconfig.Default(), grafanaURL: srv.URL}
	tc := newTempoQueryClient(srv.URL, "", http.Header{})

	dims, ok := app.detectTraceDimensions(context.Background(), tc, "uid", "svc", time.Unix(0, 0), time.Unix(3600, 0))
	if ok {
		t.Errorf("tempoOK = true, want false when every probe errors")
	}
	if dims != nil {
		t.Errorf("dims = %v, want nil", dims)
	}
}

func TestSpanMetricsBreakdownFallback(t *testing.T) {
	// db.system fallback via span metrics. rate keyed on the db_system label.
	rate := []queries.PromResult{
		{Metric: map[string]string{"db_system": "postgresql"}, Value: queries.NewPromValue(0, "5")},
		{Metric: map[string]string{"db_system": "redis"}, Value: queries.NewPromValue(0, "2")},
	}
	errs := []queries.PromResult{
		{Metric: map[string]string{"db_system": "postgresql"}, Value: queries.NewPromValue(0, "1")},
	}
	p95 := []queries.PromResult{
		{Metric: map[string]string{"db_system": "postgresql"}, Value: queries.NewPromValue(0, "40")},
		{Metric: map[string]string{"db_system": "redis"}, Value: queries.NewPromValue(0, "5")},
	}
	p99 := []queries.PromResult{
		{Metric: map[string]string{"db_system": "postgresql"}, Value: queries.NewPromValue(0, "90")},
		{Metric: map[string]string{"db_system": "redis"}, Value: queries.NewPromValue(0, "8")},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("query")
		pick := func() []queries.PromResult {
			switch {
			case strings.Contains(query, "STATUS_CODE_ERROR"):
				return errs
			case strings.Contains(query, "0.95"):
				return p95
			case strings.Contains(query, "0.99"):
				return p99
			default:
				return rate
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(queries.PromResponse{
			Status: "success",
			Data:   queries.PromData{ResultType: "vector", Result: pick()},
		})
	}))
	t.Cleanup(srv.Close)

	app := &App{otelCfg: otelconfig.Default(), grafanaURL: srv.URL}
	app.promClient = queries.NewPrometheusClient(srv.URL, "")

	caps := queries.Capabilities{}
	caps.SpanMetrics.Detected = true
	caps.SpanMetrics.CallsMetric = "traces_spanmetrics_calls_total"
	caps.SpanMetrics.DurationMetric = "traces_spanmetrics_duration_milliseconds_bucket"
	caps.SpanMetrics.DurationUnit = "ms"

	dims, rows := app.spanMetricsBreakdown(context.Background(), caps, "", "my-svc", "db.system", time.Unix(1000, 0))

	if got := strings.Join(dims, ","); got != "name,db.system" {
		t.Errorf("dims = %q, want name,db.system", got)
	}
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d: %+v", len(rows), rows)
	}
	// Sorted p99 desc: postgresql (90) before redis (8).
	if rows[0].Value != "postgresql" || rows[1].Value != "redis" {
		t.Errorf("row order = [%s,%s], want [postgresql, redis]", rows[0].Value, rows[1].Value)
	}
	pg := rows[0]
	if pg.Rate != 5 || pg.ErrorRate != 20 || pg.P95Ms != 40 || pg.P99Ms != 90 {
		t.Errorf("postgresql = %+v, want rate 5, err 20, p95 40, p99 90", pg)
	}
}

func TestMeanNonNull(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	tests := []struct {
		name    string
		in      []*float64
		wantVal float64
		wantOK  bool
	}{
		{"averages buckets", []*float64{f(2), f(4)}, 3, true},
		{"skips nulls", []*float64{nil, f(6), nil}, 6, true},
		{"all null", []*float64{nil, nil}, 0, false},
		{"empty", nil, 0, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			v, ok := meanNonNull(tc.in)
			if v != tc.wantVal || ok != tc.wantOK {
				t.Errorf("meanNonNull = (%v,%v), want (%v,%v)", v, ok, tc.wantVal, tc.wantOK)
			}
		})
	}
}

func TestStripQuotedLabels(t *testing.T) {
	got := stripQuotedLabels(map[string]string{"status": `"error"`, "name": `"GET /a"`})
	if got["status"] != "error" || got["name"] != "GET /a" {
		t.Errorf("stripQuotedLabels = %+v, want unquoted values", got)
	}
}

func TestRealDimensionValue(t *testing.T) {
	tests := []struct {
		in   string
		want bool
	}{
		{"postgresql", true},
		{"nil", false},
		{"", false},
		{"  ", false},
	}
	for _, tc := range tests {
		if got := realDimensionValue(tc.in); got != tc.want {
			t.Errorf("realDimensionValue(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}
