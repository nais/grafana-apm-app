package plugin

import (
	"fmt"
	"testing"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

func testApp() *App {
	cfg := otelconfig.Default()
	return &App{otelCfg: cfg}
}

func TestClassifyCause(t *testing.T) {
	tests := []struct {
		name string
		s    HealthSummary
		want string
	}{
		{
			name: "nothing degraded",
			s:    HealthSummary{Rate: 10, ErrorRate: 0},
			want: "",
		},
		{
			name: "only ops degraded",
			s: HealthSummary{
				Rate:      100,
				ErrorRate: 10,
				DegradedOps: []DegradedOperation{
					{SpanName: "GET /foo", ErrorAnomaly: true, Rate: 50, ErrorRate: 15},
				},
			},
			want: "no-downstream-detected",
		},
		{
			name: "only deps degraded",
			s: HealthSummary{
				Rate:      100,
				ErrorRate: 0,
				DegradedDeps: []DegradedDependency{
					{Name: "db", ErrorAnomaly: true, Rate: 30, ErrorRate: 40},
				},
			},
			want: "downstream-only",
		},
		{
			name: "both degraded with high dep error volume — downstream likely",
			s: HealthSummary{
				Rate:      100,
				ErrorRate: 10, // 10 errors/sec
				DegradedOps: []DegradedOperation{
					{SpanName: "GET /foo", ErrorAnomaly: true, Rate: 80, ErrorRate: 12},
				},
				DegradedDeps: []DegradedDependency{
					{Name: "user-svc", ErrorAnomaly: true, Rate: 50, ErrorRate: 20}, // 10 err/s
				},
			},
			want: "downstream-likely",
		},
		{
			name: "both degraded with low dep error volume — mixed",
			s: HealthSummary{
				Rate:      100,
				ErrorRate: 50, // 50 errors/sec
				DegradedOps: []DegradedOperation{
					{SpanName: "GET /foo", ErrorAnomaly: true, Rate: 80, ErrorRate: 60},
				},
				DegradedDeps: []DegradedDependency{
					{Name: "cache", ErrorAnomaly: true, Rate: 5, ErrorRate: 10}, // 0.5 err/s
				},
			},
			want: "mixed",
		},
		{
			name: "both degraded but dep has only latency anomaly — mixed",
			s: HealthSummary{
				Rate:      100,
				ErrorRate: 10,
				DegradedOps: []DegradedOperation{
					{SpanName: "GET /foo", ErrorAnomaly: true, Rate: 80, ErrorRate: 12},
				},
				DegradedDeps: []DegradedDependency{
					{Name: "db", LatencyAnomaly: true, Rate: 50, ErrorRate: 0},
				},
			},
			want: "mixed",
		},
		{
			name: "both degraded with zero service error rate — mixed",
			s: HealthSummary{
				Rate:      100,
				ErrorRate: 0,
				DegradedOps: []DegradedOperation{
					{SpanName: "GET /foo", LatencyAnomaly: true, Rate: 80, ErrorRate: 0},
				},
				DegradedDeps: []DegradedDependency{
					{Name: "db", ErrorAnomaly: true, Rate: 30, ErrorRate: 20},
				},
			},
			want: "mixed",
		},
		{
			name: "multiple deps with enough combined error volume",
			s: HealthSummary{
				Rate:      100,
				ErrorRate: 10, // 10 errors/sec
				DegradedOps: []DegradedOperation{
					{SpanName: "POST /order", ErrorAnomaly: true, Rate: 60, ErrorRate: 15},
				},
				DegradedDeps: []DegradedDependency{
					{Name: "payment-svc", ErrorAnomaly: true, Rate: 20, ErrorRate: 10}, // 2 err/s
					{Name: "inventory-svc", ErrorAnomaly: true, Rate: 15, ErrorRate: 8}, // 1.2 err/s
				},
			},
			// Combined dep errors: 3.2 err/s, threshold: 10 * 0.3 = 3.0 → downstream-likely
			want: "downstream-likely",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyCause(tt.s)
			if got != tt.want {
				t.Errorf("classifyCause() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestDetectDegradedOps(t *testing.T) {
	app := testApp()
	labels := app.otelCfg.Labels

	makeResult := func(spanName, spanKind string, val float64) queries.PromResult {
		return queries.PromResult{
			Metric: map[string]string{labels.SpanName: spanName, labels.SpanKind: spanKind},
			Value:  queries.NewPromValue(0, fmt.Sprintf("%f", val)),
		}
	}

	t.Run("no anomaly when error rate is stable", func(t *testing.T) {
		// 100 req/s, 2% error both current and previous → no anomaly
		resultMap := map[string][]queries.PromResult{
			"opRate":      {makeResult("GET /foo", "SPAN_KIND_SERVER", 100)},
			"opError":     {makeResult("GET /foo", "SPAN_KIND_SERVER", 2)},   // 2/100=2%
			"opP95":       {makeResult("GET /foo", "SPAN_KIND_SERVER", 100)},
			"opPrevRate":  {makeResult("GET /foo", "SPAN_KIND_SERVER", 100)},
			"opPrevError": {makeResult("GET /foo", "SPAN_KIND_SERVER", 2)},   // 2/100=2%
			"opPrevP95":   {makeResult("GET /foo", "SPAN_KIND_SERVER", 100)},
		}
		degraded := app.detectDegradedOps(resultMap, "ms")
		if len(degraded) != 0 {
			t.Errorf("expected no degraded ops, got %d", len(degraded))
		}
	})

	t.Run("error anomaly when error rate doubles and exceeds threshold", func(t *testing.T) {
		// Current: 100 req/s, 10% error; Previous: 80 req/s, 3% error
		resultMap := map[string][]queries.PromResult{
			"opRate":      {makeResult("GET /foo", "SPAN_KIND_SERVER", 100)},
			"opError":     {makeResult("GET /foo", "SPAN_KIND_SERVER", 10)},  // 10%
			"opP95":       {makeResult("GET /foo", "SPAN_KIND_SERVER", 100)},
			"opPrevRate":  {makeResult("GET /foo", "SPAN_KIND_SERVER", 80)},
			"opPrevError": {makeResult("GET /foo", "SPAN_KIND_SERVER", 2.4)}, // 2.4/80=3%
			"opPrevP95":   {makeResult("GET /foo", "SPAN_KIND_SERVER", 100)},
		}
		degraded := app.detectDegradedOps(resultMap, "ms")
		if len(degraded) != 1 {
			t.Fatalf("expected 1 degraded op, got %d", len(degraded))
		}
		if !degraded[0].ErrorAnomaly {
			t.Error("expected ErrorAnomaly to be true")
		}
		if degraded[0].LatencyAnomaly {
			t.Error("expected LatencyAnomaly to be false")
		}
	})

	t.Run("absolute error threshold triggers without delta", func(t *testing.T) {
		// Both periods at 6% error → absolute threshold (≥5%) triggers
		resultMap := map[string][]queries.PromResult{
			"opRate":      {makeResult("GET /foo", "SPAN_KIND_SERVER", 100)},
			"opError":     {makeResult("GET /foo", "SPAN_KIND_SERVER", 6)},  // 6%
			"opP95":       {makeResult("GET /foo", "SPAN_KIND_SERVER", 50)},
			"opPrevRate":  {makeResult("GET /foo", "SPAN_KIND_SERVER", 100)},
			"opPrevError": {makeResult("GET /foo", "SPAN_KIND_SERVER", 6)},  // 6%
			"opPrevP95":   {makeResult("GET /foo", "SPAN_KIND_SERVER", 50)},
		}
		degraded := app.detectDegradedOps(resultMap, "ms")
		if len(degraded) != 1 {
			t.Fatalf("expected 1 degraded op (absolute threshold), got %d", len(degraded))
		}
		if !degraded[0].ErrorAnomaly {
			t.Error("expected ErrorAnomaly to be true")
		}
	})

	t.Run("latency anomaly when P95 doubles and exceeds minimum increase", func(t *testing.T) {
		// Current P95: 200ms, Previous P95: 80ms → 120ms increase, 2.5x factor
		resultMap := map[string][]queries.PromResult{
			"opRate":      {makeResult("GET /foo", "SPAN_KIND_SERVER", 50)},
			"opError":     {makeResult("GET /foo", "SPAN_KIND_SERVER", 0)},
			"opP95":       {makeResult("GET /foo", "SPAN_KIND_SERVER", 200)},
			"opPrevRate":  {makeResult("GET /foo", "SPAN_KIND_SERVER", 50)},
			"opPrevError": {makeResult("GET /foo", "SPAN_KIND_SERVER", 0)},
			"opPrevP95":   {makeResult("GET /foo", "SPAN_KIND_SERVER", 80)},
		}
		degraded := app.detectDegradedOps(resultMap, "ms")
		if len(degraded) != 1 {
			t.Fatalf("expected 1 degraded op (latency), got %d", len(degraded))
		}
		if !degraded[0].LatencyAnomaly {
			t.Error("expected LatencyAnomaly to be true")
		}
		if degraded[0].ErrorAnomaly {
			t.Error("expected ErrorAnomaly to be false")
		}
	})

	t.Run("low traffic ops are ignored", func(t *testing.T) {
		// Rate below anomalyMinRate (0.1) → skip
		resultMap := map[string][]queries.PromResult{
			"opRate":      {makeResult("GET /foo", "SPAN_KIND_SERVER", 0.05)},
			"opError":     {makeResult("GET /foo", "SPAN_KIND_SERVER", 0.05)}, // 100% error
			"opP95":       {makeResult("GET /foo", "SPAN_KIND_SERVER", 5000)},
			"opPrevRate":  {},
			"opPrevError": {},
			"opPrevP95":   {},
		}
		degraded := app.detectDegradedOps(resultMap, "ms")
		if len(degraded) != 0 {
			t.Errorf("expected no degraded ops for low-traffic, got %d", len(degraded))
		}
	})

	t.Run("uses previous rate for accurate baseline calculation", func(t *testing.T) {
		// Current: 100 req/s, 3 err/s (3%)
		// Previous: 50 req/s, 1.5 err/s → should be 3%, NOT 1.5%
		// Without the fix, this would wrongly calculate prev as 1.5/100=1.5% and flag delta anomaly
		resultMap := map[string][]queries.PromResult{
			"opRate":      {makeResult("GET /foo", "SPAN_KIND_SERVER", 100)},
			"opError":     {makeResult("GET /foo", "SPAN_KIND_SERVER", 3)},   // 3%
			"opP95":       {makeResult("GET /foo", "SPAN_KIND_SERVER", 100)},
			"opPrevRate":  {makeResult("GET /foo", "SPAN_KIND_SERVER", 50)},
			"opPrevError": {makeResult("GET /foo", "SPAN_KIND_SERVER", 1.5)}, // 1.5/50=3% (correct)
			"opPrevP95":   {makeResult("GET /foo", "SPAN_KIND_SERVER", 100)},
		}
		degraded := app.detectDegradedOps(resultMap, "ms")
		// Error rate is same (3% both periods) and below absolute threshold → no anomaly
		if len(degraded) != 0 {
			t.Errorf("expected no degraded ops (same error rate), got %d: %+v", len(degraded), degraded)
		}
	})
}

func TestWrapOffset(t *testing.T) {
	tests := []struct {
		query    string
		offset   string
		expected string
	}{
		{
			query:    `rate(my_metric{foo="bar"}[5m])`,
			offset:   ` offset 3600s`,
			expected: `rate(my_metric{foo="bar"}[5m] offset 3600s)`,
		},
		{
			query:    `histogram_quantile(0.95, sum by (le) (rate(my_bucket{svc="a"}[5m])))`,
			offset:   ` offset 1h`,
			expected: `histogram_quantile(0.95, sum by (le) (rate(my_bucket{svc="a"}[5m] offset 1h)))`,
		},
		{
			query:    `no_brackets`,
			offset:   ` offset 1h`,
			expected: `no_brackets`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			got := wrapOffset(tt.query, tt.offset)
			if got != tt.expected {
				t.Errorf("wrapOffset() = %q, want %q", got, tt.expected)
			}
		})
	}
}
