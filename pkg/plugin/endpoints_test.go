package plugin

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

func TestHandleEndpointsUsesSelectedRange(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	promSrv, captured := queryCapturingPromServer(t, map[string][]queries.PromResult{
		`span_kind="SPAN_KIND_SERVER"`: {
			{
				Metric: map[string]string{"span_name": "GET /api/testusers/managed/{id}"},
				Value:  queries.NewPromValue(float64(now.Unix()), "0.01"),
			},
		},
	})
	defer promSrv.Close()

	app := newTestApp(t, promSrv.URL, defaultCaps())
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf(
		"/services/traktor/ida/endpoints?from=%d&to=%d&environment=prod",
		now.Add(-time.Hour).Unix(), now.Unix(),
	), nil)
	req.SetPathValue("namespace", "traktor")
	req.SetPathValue("service", "ida")
	w := httptest.NewRecorder()
	app.handleEndpoints(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var groups queries.EndpointGroups
	if err := json.Unmarshal(w.Body.Bytes(), &groups); err != nil {
		t.Fatal(err)
	}
	if len(groups.HTTP) != 1 || groups.HTTP[0].HTTPRoute != "/api/testusers/managed/{id}" {
		t.Fatalf("expected historical HTTP endpoint, got %+v", groups.HTTP)
	}

	found := false
	for _, query := range *captured {
		if strings.Contains(query, `span_kind="SPAN_KIND_SERVER"`) &&
			strings.Contains(query, `service_name="ida"`) &&
			strings.Contains(query, `service_namespace="traktor"`) &&
			strings.Contains(query, `k8s_cluster_name="prod"`) &&
			strings.Contains(query, "rate(traces_spanmetrics_calls_total") &&
			strings.Contains(query, "[1h]") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected endpoint rate query spanning selected hour; queries: %v", *captured)
	}
}

func TestHandleEndpointsCacheKeyIncludesQueryWindow(t *testing.T) {
	promSrv := mockPromServer(t, nil)
	defer promSrv.Close()
	app := newTestApp(t, promSrv.URL, defaultCaps())

	base := time.Now().Add(-time.Hour).Unix() / 30 * 30
	request := func(from, to int64) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, fmt.Sprintf(
			"/services/traktor/ida/endpoints?from=%d&to=%d", from, to,
		), nil)
		req.SetPathValue("namespace", "traktor")
		req.SetPathValue("service", "ida")
		w := httptest.NewRecorder()
		app.handleEndpoints(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		return w
	}

	// Both timestamp pairs round to the same 30-second cache buckets, but
	// their PromQL lookbacks round to 30m and 31m respectively.
	if got := request(base+29, base+1830).Header().Get("X-Cache"); got == "HIT" {
		t.Fatal("first 30m request should miss the cache")
	}
	if got := request(base+29, base+1830).Header().Get("X-Cache"); got != "HIT" {
		t.Fatal("repeated 30m request should hit the cache")
	}
	if got := request(base, base+1859).Header().Get("X-Cache"); got == "HIT" {
		t.Fatal("31m request should not reuse the 30m response")
	}
	if got := request(base, base+1859).Header().Get("X-Cache"); got != "HIT" {
		t.Fatal("repeated 31m request should hit the cache")
	}
}

func TestParseHTTPSpanName(t *testing.T) {
	tests := []struct {
		input      string
		wantMethod string
		wantRoute  string
	}{
		{"GET /api/users", "GET", "/api/users"},
		{"POST /login", "POST", "/login"},
		{"DELETE /api/items/123", "DELETE", "/api/items/123"},
		{"GET", "GET", ""},
		{"/api/users", "", "/api/users"},
		{"myCustomSpan", "", "myCustomSpan"},
		{"PATCH /items/{id}", "PATCH", "/items/{id}"},
		{"OPTIONS /", "OPTIONS", "/"},
		{"INVALID_LONG_TOKEN /path", "", "INVALID_LONG_TOKEN /path"},
		{"", "", ""},
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			method, route := parseHTTPSpanName(tc.input)
			if method != tc.wantMethod {
				t.Errorf("parseHTTPSpanName(%q) method = %q, want %q", tc.input, method, tc.wantMethod)
			}
			if route != tc.wantRoute {
				t.Errorf("parseHTTPSpanName(%q) route = %q, want %q", tc.input, route, tc.wantRoute)
			}
		})
	}
}

func TestFilterNoisyEndpoints(t *testing.T) {
	makeEps := func(spanNames ...string) []queries.EndpointSummary {
		var eps []queries.EndpointSummary
		for _, name := range spanNames {
			method, route := parseHTTPSpanName(name)
			eps = append(eps, queries.EndpointSummary{
				SpanName:   name,
				HTTPMethod: method,
				HTTPRoute:  route,
			})
		}
		return eps
	}

	names := func(eps []queries.EndpointSummary) []string {
		var out []string
		for _, ep := range eps {
			out = append(out, ep.SpanName)
		}
		return out
	}

	tests := []struct {
		name     string
		input    []string
		expected []string
	}{
		{
			name:     "keeps normal API routes",
			input:    []string{"GET /api/users", "POST /login", "GET /health"},
			expected: []string{"GET /api/users", "POST /login", "GET /health"},
		},
		{
			name:     "filters _next at root",
			input:    []string{"GET /_next/data/abc/page.json", "GET /api/real"},
			expected: []string{"GET /api/real"},
		},
		{
			name:     "filters _next nested under base path",
			input:    []string{"GET /syk/sykepengesoknad/_next/data/abc123/page.json", "GET /api/real"},
			expected: []string{"GET /api/real"},
		},
		{
			name:     "filters static file extensions",
			input:    []string{"GET /bundle.js", "GET /style.css", "GET /logo.png", "GET /api/data"},
			expected: []string{"GET /api/data"},
		},
		{
			name:     "filters exact noisy paths",
			input:    []string{"GET /manifest.json", "GET /robots.txt", "GET /favicon.ico", "GET /api/ok"},
			expected: []string{"GET /api/ok"},
		},
		{
			name:     "filters static directories",
			input:    []string{"GET /static/js/main.js", "GET /assets/logo.svg", "GET /api/items"},
			expected: []string{"GET /api/items"},
		},
		{
			name:     "filters webpack and vite dev routes",
			input:    []string{"GET /__webpack_hmr", "GET /@vite/client", "GET /api/ok"},
			expected: []string{"GET /api/ok"},
		},
		{
			name:     "empty input",
			input:    []string{},
			expected: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := filterNoisyEndpoints(makeEps(tc.input...))
			got := names(result)

			if len(got) != len(tc.expected) {
				t.Fatalf("got %d endpoints %v, want %d %v", len(got), got, len(tc.expected), tc.expected)
			}
			for i, want := range tc.expected {
				if got[i] != want {
					t.Errorf("[%d] = %q, want %q", i, got[i], want)
				}
			}
		})
	}
}

func TestSafeFloat(t *testing.T) {
	tests := []struct {
		name     string
		input    float64
		expected float64
	}{
		{"normal value", 42.5, 42.5},
		{"zero", 0, 0},
		{"negative", -1.5, -1.5},
		{"NaN", math.NaN(), 0},
		{"positive infinity", math.Inf(1), 0},
		{"negative infinity", math.Inf(-1), 0},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := safeFloat(tc.input)
			if got != tc.expected {
				t.Errorf("safeFloat(%v) = %v, want %v", tc.input, got, tc.expected)
			}
		})
	}
}
