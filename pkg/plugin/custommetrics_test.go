package plugin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// customMetricsMockServer serves both /api/v1/query (substring-routed canned
// vectors, like mockPromServer) and /api/v1/metadata (per-metric metadata).
// It records instant queries for assertion.
func customMetricsMockServer(
	t *testing.T,
	resultsMap map[string][]queries.PromResult,
	metadata map[string][]queries.MetricMetadata,
) (*httptest.Server, *[]string) {
	t.Helper()
	var mu sync.Mutex
	captured := &[]string{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if strings.HasSuffix(r.URL.Path, "/api/v1/metadata") {
			metric := r.URL.Query().Get("metric")
			data := map[string][]queries.MetricMetadata{}
			if entries, ok := metadata[metric]; ok {
				data[metric] = entries
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": data})
			return
		}

		query := r.URL.Query().Get("query")
		mu.Lock()
		*captured = append(*captured, query)
		mu.Unlock()

		for key, results := range resultsMap {
			if strings.Contains(query, key) {
				_ = json.NewEncoder(w).Encode(queries.PromResponse{
					Status: "success",
					Data:   queries.PromData{ResultType: "vector", Result: results},
				})
				return
			}
		}
		_ = json.NewEncoder(w).Encode(queries.PromResponse{
			Status: "success",
			Data:   queries.PromData{ResultType: "vector", Result: []queries.PromResult{}},
		})
	}))
	return srv, captured
}

func nameResults(names ...string) []queries.PromResult {
	out := make([]queries.PromResult, 0, len(names))
	for _, n := range names {
		out = append(out, queries.PromResult{
			Metric: map[string]string{"__name__": n},
			Value:  queries.NewPromValue(0, "1"),
		})
	}
	return out
}

func countResult(n int) []queries.PromResult {
	return []queries.PromResult{{
		Metric: map[string]string{},
		Value:  queries.NewPromValue(0, fmt.Sprintf("%d", n)),
	}}
}

func getCustomMetrics(t *testing.T, app *App) CustomMetricsResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/services/team/app/custom-metrics?from=100&to=200", nil)
	req.SetPathValue("namespace", "team")
	req.SetPathValue("service", "app")
	w := httptest.NewRecorder()
	app.handleCustomMetrics(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp CustomMetricsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %s", err)
	}
	return resp
}

func TestHandleCustomMetrics(t *testing.T) {
	t.Run("discovery uses the runtime filter and the otelconfig denylist", func(t *testing.T) {
		srv, captured := customMetricsMockServer(t, map[string][]queries.PromResult{
			"group by (__name__)": nameResults("orders_processed_total", "queue_depth"),
			"count({__name__=":    countResult(3),
		}, nil)
		defer srv.Close()

		app := newTestApp(t, srv.URL, defaultCaps())
		resp := getCustomMetrics(t, app)

		var discovery string
		for _, q := range *captured {
			if strings.Contains(q, "group by (__name__)") {
				discovery = q
			}
		}
		if discovery == "" {
			t.Fatal("no discovery query captured")
		}
		if !strings.Contains(discovery, `app="app", namespace="team"`) {
			t.Errorf("discovery query missing runtime filter: %s", discovery)
		}
		if !strings.Contains(discovery, `__name__!~"`+app.otelCfg.CustomMetrics.Denylist+`"`) {
			t.Errorf("discovery query missing otelconfig denylist: %s", discovery)
		}

		if len(resp.Metrics) != 2 {
			t.Fatalf("expected 2 metrics, got %d", len(resp.Metrics))
		}
		// Sorted alphabetically.
		if resp.Metrics[0].Name != "orders_processed_total" || resp.Metrics[1].Name != "queue_depth" {
			t.Errorf("unexpected metric names: %+v", resp.Metrics)
		}
		if resp.Truncated {
			t.Error("expected truncated=false")
		}
	})

	t.Run("enriches from the metadata API and derives chart from type", func(t *testing.T) {
		srv, _ := customMetricsMockServer(t, map[string][]queries.PromResult{
			"group by (__name__)": nameResults("orders_processed_total"),
			"count({__name__=":    countResult(12),
		}, map[string][]queries.MetricMetadata{
			"orders_processed_total": {{Type: "counter", Help: "Orders processed", Unit: "orders"}},
		})
		defer srv.Close()

		app := newTestApp(t, srv.URL, defaultCaps())
		resp := getCustomMetrics(t, app)

		if len(resp.Metrics) != 1 {
			t.Fatalf("expected 1 metric, got %d", len(resp.Metrics))
		}
		m := resp.Metrics[0]
		if m.Type != "counter" || m.Help != "Orders processed" || m.Unit != "orders" {
			t.Errorf("metadata not applied: %+v", m)
		}
		if m.Chart != "rate" {
			t.Errorf("expected chart=rate for counter, got %q", m.Chart)
		}
		if m.Series != 12 {
			t.Errorf("expected series=12, got %d", m.Series)
		}
	})

	t.Run("falls back to suffix heuristics when metadata is absent", func(t *testing.T) {
		srv, _ := customMetricsMockServer(t, map[string][]queries.PromResult{
			"group by (__name__)": nameResults(
				"soknad_innsendt_total",
				"batch_duration_seconds_bucket",
				"batch_duration_seconds_sum",
				"batch_duration_seconds_count",
				"queue_depth",
				"payload_bytes",
			),
			"count({__name__=": countResult(4),
		}, nil)
		defer srv.Close()

		app := newTestApp(t, srv.URL, defaultCaps())
		resp := getCustomMetrics(t, app)

		byName := map[string]CustomMetric{}
		for _, m := range resp.Metrics {
			byName[m.Name] = m
		}

		// _bucket/_sum/_count collapse into one histogram family.
		if len(resp.Metrics) != 4 {
			t.Fatalf("expected 4 families, got %d: %+v", len(resp.Metrics), resp.Metrics)
		}
		if m := byName["soknad_innsendt_total"]; m.Type != "counter" || m.Chart != "rate" {
			t.Errorf("_total heuristic failed: %+v", m)
		}
		if m := byName["batch_duration_seconds"]; m.Type != "histogram" || m.Chart != "p95" || m.Unit != "seconds" {
			t.Errorf("histogram heuristic failed: %+v", m)
		}
		if m := byName["queue_depth"]; m.Type != "gauge" || m.Chart != "gauge" || m.Unit != "" {
			t.Errorf("gauge heuristic failed: %+v", m)
		}
		if m := byName["payload_bytes"]; m.Unit != "bytes" {
			t.Errorf("_bytes unit heuristic failed: %+v", m)
		}
	})

}
func TestHandleCustomMetricsGuards(t *testing.T) {

	t.Run("flags high-cardinality families over the threshold", func(t *testing.T) {
		srv, captured := customMetricsMockServer(t, map[string][]queries.PromResult{
			"group by (__name__)":             nameResults("chatty_metric", "quiet_metric"),
			`count({__name__="chatty_metric"`: countResult(150),
			`count({__name__="quiet_metric"`:  countResult(99),
		}, nil)
		defer srv.Close()

		app := newTestApp(t, srv.URL, defaultCaps())
		resp := getCustomMetrics(t, app)

		byName := map[string]CustomMetric{}
		for _, m := range resp.Metrics {
			byName[m.Name] = m
		}
		if m := byName["chatty_metric"]; !m.HighCardinality || m.Series != 150 {
			t.Errorf("expected chatty_metric flagged high-cardinality: %+v", m)
		}
		if m := byName["quiet_metric"]; m.HighCardinality {
			t.Errorf("expected quiet_metric not flagged: %+v", m)
		}

		// The guard query scopes the count to the service filter.
		var sawScopedCount bool
		for _, q := range *captured {
			if strings.Contains(q, `count({__name__="chatty_metric", app="app", namespace="team"})`) {
				sawScopedCount = true
			}
		}
		if !sawScopedCount {
			t.Errorf("series count query not scoped to service filter: %v", *captured)
		}
	})

	t.Run("caps families at 50 and sets truncated", func(t *testing.T) {
		names := make([]string, 60)
		for i := range names {
			names[i] = fmt.Sprintf("custom_metric_%02d", i)
		}
		srv, _ := customMetricsMockServer(t, map[string][]queries.PromResult{
			"group by (__name__)": nameResults(names...),
			"count({__name__=":    countResult(1),
		}, nil)
		defer srv.Close()

		app := newTestApp(t, srv.URL, defaultCaps())
		resp := getCustomMetrics(t, app)

		if len(resp.Metrics) != maxCustomMetricFamilies {
			t.Errorf("expected %d metrics, got %d", maxCustomMetricFamilies, len(resp.Metrics))
		}
		if !resp.Truncated {
			t.Error("expected truncated=true")
		}
	})

	t.Run("returns empty metrics array when nothing is discovered", func(t *testing.T) {
		srv, _ := customMetricsMockServer(t, nil, nil)
		defer srv.Close()

		app := newTestApp(t, srv.URL, defaultCaps())
		resp := getCustomMetrics(t, app)

		if resp.Metrics == nil || len(resp.Metrics) != 0 {
			t.Errorf("expected empty non-nil metrics, got %+v", resp.Metrics)
		}
	})
}
