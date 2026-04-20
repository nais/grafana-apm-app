package plugin

import (
	"math"
	"testing"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

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
