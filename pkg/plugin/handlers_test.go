package plugin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// mockPromServer returns an httptest.Server that serves canned Prometheus responses.
// The handler routes instant queries to /api/v1/query and range queries to /api/v1/query_range.
// The resultsMap maps query substrings to canned results.
func mockPromServer(t *testing.T, resultsMap map[string][]queries.PromResult) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("query")

		// Find matching canned result by checking if any key is a substring of the query
		for key, results := range resultsMap {
			if strings.Contains(query, key) {
				resp := queries.PromResponse{
					Status: "success",
					Data: queries.PromData{
						ResultType: "vector",
						Result:     results,
					},
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(resp)
				return
			}
		}

		// Default: empty result
		resp := queries.PromResponse{
			Status: "success",
			Data: queries.PromData{
				ResultType: "vector",
				Result:     []queries.PromResult{},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
}

// newTestApp creates an App with a mock Prometheus backend and pre-set capabilities.
func newTestApp(t *testing.T, promURL string, caps queries.Capabilities) *App {
	t.Helper()
	app := &App{
		otelCfg:    otelconfig.Default(),
		respCache:  newResponseCache(30*time.Second, 200),
		promClient: queries.NewPrometheusClient(promURL, ""),
	}

	// Pre-set capabilities so detection isn't needed
	app.capCache = &cachedCapabilities{
		caps:      caps,
		fetchedAt: time.Now(),
	}

	mux := http.NewServeMux()
	app.registerRoutes(mux)

	return app
}

// defaultCaps returns a Capabilities with span metrics detected.
func defaultCaps() queries.Capabilities {
	return queries.Capabilities{
		SpanMetrics: queries.SpanMetricsCapability{
			Detected:       true,
			Namespace:      "traces_spanmetrics",
			CallsMetric:    "traces_spanmetrics_calls_total",
			DurationMetric: "traces_spanmetrics_duration_milliseconds_bucket",
			DurationUnit:   "ms",
		},
		ServiceGraph: queries.ServiceGraphCapability{
			Detected: true,
			Prefix:   "traces_service_graph",
		},
	}
}

func TestHandleServices(t *testing.T) {
	now := time.Now()
	from := fmt.Sprintf("%d", now.Add(-1*time.Hour).Unix())
	to := fmt.Sprintf("%d", now.Unix())

	t.Run("returns empty array when no span metrics detected", func(t *testing.T) {
		promSrv := mockPromServer(t, nil)
		defer promSrv.Close()

		noCaps := queries.Capabilities{
			SpanMetrics: queries.SpanMetricsCapability{Detected: false},
		}
		app := newTestApp(t, promSrv.URL, noCaps)

		req := httptest.NewRequest(http.MethodGet, "/services?from="+from+"&to="+to, nil)
		w := httptest.NewRecorder()
		app.handleServices(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		var result []queries.ServiceSummary
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatalf("invalid JSON: %s", err)
		}
		if len(result) != 0 {
			t.Errorf("expected empty array, got %d services", len(result))
		}
	})

	t.Run("returns 503 when promClient is nil", func(t *testing.T) {
		app := &App{
			otelCfg:   otelconfig.Default(),
			respCache: newResponseCache(30*time.Second, 200),
		}
		req := httptest.NewRequest(http.MethodGet, "/services", nil)
		w := httptest.NewRecorder()
		app.handleServices(w, req)

		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("expected 503, got %d", w.Code)
		}
	})

	t.Run("returns services from prometheus data", func(t *testing.T) {
		cfg := otelconfig.Default()
		results := map[string][]queries.PromResult{
			"rate(traces_spanmetrics_calls_total": {
				{
					Metric: map[string]string{
						cfg.Labels.ServiceName:      "frontend",
						cfg.Labels.ServiceNamespace:  "otel-demo",
						cfg.Labels.DeploymentEnv:     "production",
					},
					Value: queries.PromValue{float64(now.Unix()), "10.5"},
				},
			},
			"status_code": {
				{
					Metric: map[string]string{
						cfg.Labels.ServiceName:      "frontend",
						cfg.Labels.ServiceNamespace:  "otel-demo",
						cfg.Labels.DeploymentEnv:     "production",
					},
					Value: queries.PromValue{float64(now.Unix()), "0.5"},
				},
			},
			"histogram_quantile": {
				{
					Metric: map[string]string{
						cfg.Labels.ServiceName:      "frontend",
						cfg.Labels.ServiceNamespace:  "otel-demo",
						cfg.Labels.DeploymentEnv:     "production",
					},
					Value: queries.PromValue{float64(now.Unix()), "42.5"},
				},
			},
			"group by": {
				{
					Metric: map[string]string{
						cfg.Labels.ServiceName:      "frontend",
						cfg.Labels.ServiceNamespace:  "otel-demo",
						cfg.Labels.SDKLanguage:       "go",
						cfg.Labels.DeploymentEnv:     "production",
					},
					Value: queries.PromValue{float64(now.Unix()), "1"},
				},
			},
		}

		promSrv := mockPromServer(t, results)
		defer promSrv.Close()

		app := newTestApp(t, promSrv.URL, defaultCaps())
		req := httptest.NewRequest(http.MethodGet,
			"/services?from="+from+"&to="+to+"&withSeries=false",
			nil)
		w := httptest.NewRecorder()
		app.handleServices(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var services []queries.ServiceSummary
		if err := json.Unmarshal(w.Body.Bytes(), &services); err != nil {
			t.Fatalf("invalid JSON: %s", err)
		}
		if len(services) == 0 {
			t.Fatal("expected at least 1 service")
		}
		svc := services[0]
		if svc.Name != "frontend" {
			t.Errorf("expected service name 'frontend', got %q", svc.Name)
		}
		if svc.Namespace != "otel-demo" {
			t.Errorf("expected namespace 'otel-demo', got %q", svc.Namespace)
		}
		if svc.SDKLanguage != "go" {
			t.Errorf("expected sdk language 'go', got %q", svc.SDKLanguage)
		}
	})

	t.Run("filters by namespace", func(t *testing.T) {
		promSrv := mockPromServer(t, map[string][]queries.PromResult{})
		defer promSrv.Close()

		app := newTestApp(t, promSrv.URL, defaultCaps())
		req := httptest.NewRequest(http.MethodGet,
			"/services?from="+from+"&to="+to+"&namespace=my-ns&withSeries=false",
			nil)
		w := httptest.NewRecorder()
		app.handleServices(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
	})

	t.Run("rejects POST", func(t *testing.T) {
		promSrv := mockPromServer(t, nil)
		defer promSrv.Close()
		app := newTestApp(t, promSrv.URL, defaultCaps())

		req := httptest.NewRequest(http.MethodPost, "/services", nil)
		w := httptest.NewRecorder()
		app.handleServices(w, req)

		if w.Code != http.StatusMethodNotAllowed {
			t.Errorf("expected 405, got %d", w.Code)
		}
	})
}

func TestHandleServiceMap(t *testing.T) {
	t.Run("returns empty graph when service graph not detected", func(t *testing.T) {
		promSrv := mockPromServer(t, nil)
		defer promSrv.Close()

		noCaps := queries.Capabilities{
			ServiceGraph: queries.ServiceGraphCapability{Detected: false},
		}
		app := newTestApp(t, promSrv.URL, noCaps)

		req := httptest.NewRequest(http.MethodGet, "/service-map", nil)
		w := httptest.NewRecorder()
		app.handleServiceMap(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}

		var resp ServiceMapResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("invalid JSON: %s", err)
		}
		if len(resp.Nodes) != 0 {
			t.Errorf("expected 0 nodes, got %d", len(resp.Nodes))
		}
		if len(resp.Edges) != 0 {
			t.Errorf("expected 0 edges, got %d", len(resp.Edges))
		}
	})

	t.Run("builds graph from service graph metrics", func(t *testing.T) {
		cfg := otelconfig.Default()
		results := map[string][]queries.PromResult{
			"traces_service_graph_request_total": {
				{
					Metric: map[string]string{
						cfg.Labels.Client: "frontend",
						cfg.Labels.Server: "backend",
					},
					Value: queries.PromValue{float64(time.Now().Unix()), "100"},
				},
			},
			"traces_service_graph_request_failed_total": {},
		}

		promSrv := mockPromServer(t, results)
		defer promSrv.Close()

		app := newTestApp(t, promSrv.URL, defaultCaps())
		req := httptest.NewRequest(http.MethodGet, "/service-map", nil)
		w := httptest.NewRecorder()
		app.handleServiceMap(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp ServiceMapResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("invalid JSON: %s", err)
		}
		// Should have at least the two nodes (frontend, backend)
		if len(resp.Nodes) < 2 {
			t.Errorf("expected at least 2 nodes, got %d", len(resp.Nodes))
		}
		if len(resp.Edges) < 1 {
			t.Errorf("expected at least 1 edge, got %d", len(resp.Edges))
		}
	})
}

func TestHandleCapabilities(t *testing.T) {
	t.Run("returns cached capabilities", func(t *testing.T) {
		promSrv := mockPromServer(t, nil)
		defer promSrv.Close()

		app := newTestApp(t, promSrv.URL, defaultCaps())
		req := httptest.NewRequest(http.MethodGet, "/capabilities", nil)
		w := httptest.NewRecorder()
		app.handleCapabilities(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}

		var caps queries.Capabilities
		if err := json.Unmarshal(w.Body.Bytes(), &caps); err != nil {
			t.Fatalf("invalid JSON: %s", err)
		}
		if !caps.SpanMetrics.Detected {
			t.Error("expected SpanMetrics.Detected to be true")
		}
		if !caps.ServiceGraph.Detected {
			t.Error("expected ServiceGraph.Detected to be true")
		}
	})

	t.Run("rejects POST", func(t *testing.T) {
		promSrv := mockPromServer(t, nil)
		defer promSrv.Close()
		app := newTestApp(t, promSrv.URL, defaultCaps())

		req := httptest.NewRequest(http.MethodPost, "/capabilities", nil)
		w := httptest.NewRecorder()
		app.handleCapabilities(w, req)

		if w.Code != http.StatusMethodNotAllowed {
			t.Errorf("expected 405, got %d", w.Code)
		}
	})
}

func TestHandlePing(t *testing.T) {
	app := &App{}
	req := httptest.NewRequest(http.MethodGet, "/ping", nil)
	w := httptest.NewRecorder()
	app.handlePing(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected application/json, got %q", ct)
	}

	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %s", err)
	}
	if body["message"] != "ok" {
		t.Errorf("expected message 'ok', got %q", body["message"])
	}
}

func TestHandleGlobalDependencies(t *testing.T) {
	t.Run("returns empty when no data", func(t *testing.T) {
		promSrv := mockPromServer(t, map[string][]queries.PromResult{})
		defer promSrv.Close()

		app := newTestApp(t, promSrv.URL, defaultCaps())
		req := httptest.NewRequest(http.MethodGet, "/dependencies", nil)
		w := httptest.NewRecorder()
		app.handleGlobalDependencies(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestResponseCache(t *testing.T) {
	t.Run("caches service response", func(t *testing.T) {
		cfg := otelconfig.Default()
		now := time.Now()
		from := fmt.Sprintf("%d", now.Add(-1*time.Hour).Unix())
		to := fmt.Sprintf("%d", now.Unix())

		results := map[string][]queries.PromResult{
			"rate(traces_spanmetrics_calls_total": {
				{
					Metric: map[string]string{
						cfg.Labels.ServiceName:      "cached-svc",
						cfg.Labels.ServiceNamespace:  "ns",
						cfg.Labels.DeploymentEnv:     "prod",
					},
					Value: queries.PromValue{float64(now.Unix()), "5.0"},
				},
			},
			"group by": {
				{
					Metric: map[string]string{
						cfg.Labels.ServiceName:      "cached-svc",
						cfg.Labels.ServiceNamespace:  "ns",
						cfg.Labels.SDKLanguage:       "java",
						cfg.Labels.DeploymentEnv:     "prod",
					},
					Value: queries.PromValue{float64(now.Unix()), "1"},
				},
			},
		}

		promSrv := mockPromServer(t, results)
		defer promSrv.Close()
		app := newTestApp(t, promSrv.URL, defaultCaps())

		// First request
		req1 := httptest.NewRequest(http.MethodGet,
			"/services?from="+from+"&to="+to+"&withSeries=false", nil)
		w1 := httptest.NewRecorder()
		app.handleServices(w1, req1)

		if w1.Code != http.StatusOK {
			t.Fatalf("first request failed: %d", w1.Code)
		}
		if w1.Header().Get("X-Cache") == "HIT" {
			t.Error("first request should not be a cache hit")
		}

		// Second request (same time range, should be cached)
		req2 := httptest.NewRequest(http.MethodGet,
			"/services?from="+from+"&to="+to+"&withSeries=false", nil)
		w2 := httptest.NewRecorder()
		app.handleServices(w2, req2)

		if w2.Code != http.StatusOK {
			t.Fatalf("second request failed: %d", w2.Code)
		}
		if w2.Header().Get("X-Cache") != "HIT" {
			t.Error("second request should be a cache hit")
		}

		// Verify responses are structurally identical (cache may differ in trailing newline)
		var s1, s2 []queries.ServiceSummary
		if err := json.Unmarshal(w1.Body.Bytes(), &s1); err != nil {
			t.Fatalf("first response invalid JSON: %s", err)
		}
		if err := json.Unmarshal(w2.Body.Bytes(), &s2); err != nil {
			t.Fatalf("second response invalid JSON: %s", err)
		}
		if len(s1) != len(s2) {
			t.Errorf("service count mismatch: %d vs %d", len(s1), len(s2))
		}
	})
}

func TestHelperFunctions(t *testing.T) {
	t.Run("requireGET rejects non-GET methods", func(t *testing.T) {
		for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
			w := httptest.NewRecorder()
			req := httptest.NewRequest(method, "/test", nil)
			result := requireGET(w, req)
			if result {
				t.Errorf("requireGET should return false for %s", method)
			}
			if w.Code != http.StatusMethodNotAllowed {
				t.Errorf("expected 405 for %s, got %d", method, w.Code)
			}
		}
	})

	t.Run("requireGET allows GET", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/test", nil)
		result := requireGET(w, req)
		if !result {
			t.Error("requireGET should return true for GET")
		}
	})

	t.Run("writeJSON sets content type and writes JSON", func(t *testing.T) {
		w := httptest.NewRecorder()
		data := map[string]string{"key": "value"}
		writeJSON(w, data)

		if w.Header().Get("Content-Type") != "application/json" {
			t.Errorf("expected application/json, got %q", w.Header().Get("Content-Type"))
		}
		var result map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatalf("invalid JSON: %s", err)
		}
		if result["key"] != "value" {
			t.Errorf("expected 'value', got %q", result["key"])
		}
	})

	t.Run("parseTimeRange defaults to last hour", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/test", nil)
		from, to := parseTimeRange(req)
		if to.Sub(from) < 59*time.Minute || to.Sub(from) > 61*time.Minute {
			t.Errorf("expected ~1h range, got %v", to.Sub(from))
		}
	})

	t.Run("parseTimeRange uses query params", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/test?from=1000000&to=1003600", nil)
		from, to := parseTimeRange(req)
		if from.Unix() != 1000000 {
			t.Errorf("expected from=1000000, got %d", from.Unix())
		}
		if to.Unix() != 1003600 {
			t.Errorf("expected to=1003600, got %d", to.Unix())
		}
	})

	t.Run("parseDurationParam defaults when missing", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/test", nil)
		d := parseDurationParam(req, "step", 60*time.Second)
		if d != 60*time.Second {
			t.Errorf("expected 60s, got %v", d)
		}
	})

	t.Run("parseDurationParam parses seconds", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/test?step=120", nil)
		d := parseDurationParam(req, "step", 60*time.Second)
		if d != 120*time.Second {
			t.Errorf("expected 120s, got %v", d)
		}
	})

	t.Run("parseEnvironment sanitizes input", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, `/test?environment=prod%22OR`, nil)
		env := parseEnvironment(req)
		if strings.Contains(env, `"`) {
			t.Errorf("expected sanitized environment, got %q", env)
		}
	})
}
