package plugin

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// updateGolden regenerates the RuleFormValues golden snapshots. Run:
//
//	go test ./pkg/plugin -run TestAlertTemplateGolden -update
var updateGolden = flag.Bool("update", false, "update alert-template golden snapshots")

// newAlertTemplateApp builds a test App with datasources configured and
// capabilities pre-detected (non-default spanmetrics naming so tests catch
// hardcoded metric names).
func newAlertTemplateApp(t *testing.T) *App {
	t.Helper()
	caps := defaultCaps()
	caps.SpanMetrics.CallsMetric = "traces_span_metrics_calls_total"
	caps.SpanMetrics.Namespace = "traces_span_metrics"

	app := newTestApp(t, "http://prom.invalid", caps)
	app.settings.MetricsDataSource = queries.EnvAwareDataSource{
		UID: "mimir-default",
		ByEnvironment: map[string]queries.DataSourceRef{
			"prod-gcp": {UID: "mimir-prod-gcp"},
		},
	}
	app.settings.LogsDataSource = queries.EnvAwareDataSource{
		UID: "loki-default",
		ByEnvironment: map[string]queries.DataSourceRef{
			"prod-gcp": {UID: "loki-prod-gcp"},
		},
	}
	return app
}

// serveAlertTemplate routes the request through the registered mux so the
// {kind} path value is populated exactly as in production.
func serveAlertTemplate(t *testing.T, app *App, target string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	app.registerRoutes(mux)
	req := httptest.NewRequest(http.MethodGet, target, nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	return w
}

func decodeAlertTemplate(t *testing.T, w *httptest.ResponseRecorder) alertTemplateResponse {
	t.Helper()
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp alertTemplateResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON response: %s", err)
	}
	return resp
}

func TestHandleAlertTemplate(t *testing.T) {
	tests := []struct {
		name string
		url  string

		wantStatus     int    // 0 means 200
		wantDSUID      string // datasourceUid of query A
		wantExpr       string // exact expr of query A
		wantName       string
		wantThreshold  float64
		wantAnnotation string // exact nais_apm_url annotation value
	}{
		{
			name:      "error-rate uses detected calls metric",
			url:       "/alert-templates/error-rate?namespace=team-a&service=my-svc",
			wantDSUID: "mimir-default",
			wantExpr: `sum(rate(traces_span_metrics_calls_total{service_name="my-svc", service_namespace="team-a", status_code="STATUS_CODE_ERROR"}[5m]))` +
				` / sum(rate(traces_span_metrics_calls_total{service_name="my-svc", service_namespace="team-a"}[5m]))`,
			wantName:       "Error rate above 5% – my-svc",
			wantThreshold:  0.05,
			wantAnnotation: "/a/nais-apm-app/services/team-a/my-svc",
		},
		{
			name:      "error-rate with environment adds matcher and resolves per-env datasource",
			url:       "/alert-templates/error-rate?namespace=team-a&service=my-svc&environment=prod-gcp",
			wantDSUID: "mimir-prod-gcp",
			wantExpr: `sum(rate(traces_span_metrics_calls_total{service_name="my-svc", service_namespace="team-a", k8s_cluster_name="prod-gcp", status_code="STATUS_CODE_ERROR"}[5m]))` +
				` / sum(rate(traces_span_metrics_calls_total{service_name="my-svc", service_namespace="team-a", k8s_cluster_name="prod-gcp"}[5m]))`,
			wantName:       "Error rate above 5% – my-svc (prod-gcp)",
			wantThreshold:  0.05,
			wantAnnotation: "/a/nais-apm-app/services/team-a/my-svc?environment=prod-gcp",
		},
		{
			name:      "error-rate without namespace omits namespace matcher",
			url:       "/alert-templates/error-rate?namespace=_&service=my-svc",
			wantDSUID: "mimir-default",
			wantExpr: `sum(rate(traces_span_metrics_calls_total{service_name="my-svc", status_code="STATUS_CODE_ERROR"}[5m]))` +
				` / sum(rate(traces_span_metrics_calls_total{service_name="my-svc"}[5m]))`,
			wantName:       "Error rate above 5% – my-svc",
			wantThreshold:  0.05,
			wantAnnotation: "/a/nais-apm-app/services/_/my-svc",
		},
		{
			name:           "exception-spike single hash uses drawer query shape",
			url:            "/alert-templates/exception-spike?namespace=team-a&service=my-svc&environment=prod-gcp&hash=abc123&fingerprint=v1:9f2ab31c04d7e655",
			wantDSUID:      "loki-prod-gcp",
			wantExpr:       "sum(count_over_time({service_name=\"my-svc\", kind=\"exception\", k8s_cluster_name=\"prod-gcp\"} |= `hash=abc123` | logfmt | hash=\"abc123\" [5m]))",
			wantName:       "Exception spike – my-svc (v1:9f2ab31c04d7e655)",
			wantThreshold:  10,
			wantAnnotation: "/a/nais-apm-app/services/team-a/my-svc?environment=prod-gcp&issueId=v1%3A9f2ab31c04d7e655&tab=issues",
		},
		{
			name:           "exception-spike multiple member hashes uses regex form",
			url:            "/alert-templates/exception-spike?namespace=team-a&service=my-svc&hash=abc123,def456&fingerprint=v1:9f2ab31c04d7e655",
			wantDSUID:      "loki-default",
			wantExpr:       "sum(count_over_time({service_name=\"my-svc\", kind=\"exception\"} |~ `hash=(abc123|def456)` | logfmt | hash=~\"(abc123|def456)\" [5m]))",
			wantName:       "Exception spike – my-svc (v1:9f2ab31c04d7e655)",
			wantThreshold:  10,
			wantAnnotation: "/a/nais-apm-app/services/team-a/my-svc?issueId=v1%3A9f2ab31c04d7e655&tab=issues",
		},
		{
			name:           "exception-spike without fingerprint falls back to exceptionHash deep link",
			url:            "/alert-templates/exception-spike?namespace=team-a&service=my-svc&hash=abc123",
			wantDSUID:      "loki-default",
			wantExpr:       "sum(count_over_time({service_name=\"my-svc\", kind=\"exception\"} |= `hash=abc123` | logfmt | hash=\"abc123\" [5m]))",
			wantName:       "Exception spike – my-svc (abc123)",
			wantThreshold:  10,
			wantAnnotation: "/a/nais-apm-app/services/team-a/my-svc?exceptionHash=abc123&tab=issues",
		},
		{
			name:           "web-vitals uses alloy LCP bucket metric",
			url:            "/alert-templates/web-vitals?namespace=team-a&service=my-svc&environment=prod-gcp",
			wantDSUID:      "mimir-prod-gcp",
			wantExpr:       `histogram_quantile(0.75, sum by (le) (rate(loki_process_custom_faro_web_vitals_lcp_milliseconds_bucket{app_name="my-svc", env="prod-gcp"}[15m])))`,
			wantName:       "LCP p75 above 2.5s – my-svc (prod-gcp)",
			wantThreshold:  2500,
			wantAnnotation: "/a/nais-apm-app/services/team-a/my-svc?environment=prod-gcp&tab=frontend",
		},
		{
			name:           "web-vitals without environment omits env matcher",
			url:            "/alert-templates/web-vitals?namespace=team-a&service=my-svc",
			wantDSUID:      "mimir-default",
			wantExpr:       `histogram_quantile(0.75, sum by (le) (rate(loki_process_custom_faro_web_vitals_lcp_milliseconds_bucket{app_name="my-svc"}[15m])))`,
			wantName:       "LCP p75 above 2.5s – my-svc",
			wantThreshold:  2500,
			wantAnnotation: "/a/nais-apm-app/services/team-a/my-svc?tab=frontend",
		},
		{
			name:       "unknown kind returns 404",
			url:        "/alert-templates/nonsense?service=my-svc",
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "missing service returns 400",
			url:        "/alert-templates/error-rate?namespace=team-a",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "exception-spike without hash returns 400",
			url:        "/alert-templates/exception-spike?namespace=team-a&service=my-svc",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "exception-spike rejects non-alphanumeric hashes",
			url:        "/alert-templates/exception-spike?namespace=team-a&service=my-svc&hash=" + url.QueryEscape(`ab".*|{}`),
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			app := newAlertTemplateApp(t)
			w := serveAlertTemplate(t, app, tc.url)

			if tc.wantStatus != 0 {
				if w.Code != tc.wantStatus {
					t.Fatalf("expected %d, got %d: %s", tc.wantStatus, w.Code, w.Body.String())
				}
				return
			}

			resp := decodeAlertTemplate(t, w)
			d := resp.Defaults

			if d.Type != "grafana" {
				t.Errorf("type = %q, want %q", d.Type, "grafana")
			}
			if d.Name != tc.wantName {
				t.Errorf("name = %q, want %q", d.Name, tc.wantName)
			}
			if d.Condition != "C" {
				t.Errorf("condition = %q, want %q", d.Condition, "C")
			}
			if d.EvaluateFor != "5m" {
				t.Errorf("evaluateFor = %q, want %q", d.EvaluateFor, "5m")
			}

			if len(d.Queries) != 3 {
				t.Fatalf("expected 3 queries (A data, B reduce, C threshold), got %d", len(d.Queries))
			}
			qa := d.Queries[0]
			if qa.RefID != "A" {
				t.Errorf("queries[0].refId = %q, want A", qa.RefID)
			}
			if qa.DatasourceUID != tc.wantDSUID {
				t.Errorf("queries[0].datasourceUid = %q, want %q", qa.DatasourceUID, tc.wantDSUID)
			}
			if qa.RelativeTimeRange == nil || qa.RelativeTimeRange.From != 600 || qa.RelativeTimeRange.To != 0 {
				t.Errorf("queries[0].relativeTimeRange = %+v, want {600 0}", qa.RelativeTimeRange)
			}
			expr, _ := qa.Model["expr"].(string)
			if expr != tc.wantExpr {
				t.Errorf("queries[0].model.expr =\n  %s\nwant\n  %s", expr, tc.wantExpr)
			}

			for i, refID := range []string{"B", "C"} {
				eq := d.Queries[i+1]
				if eq.RefID != refID || eq.DatasourceUID != expressionDatasourceUID {
					t.Errorf("queries[%d] = {refId:%q uid:%q}, want {refId:%q uid:%q}", i+1, eq.RefID, eq.DatasourceUID, refID, expressionDatasourceUID)
				}
			}
			if got := thresholdParam(t, d.Queries[2]); got != tc.wantThreshold {
				t.Errorf("threshold = %v, want %v", got, tc.wantThreshold)
			}

			assertAnnotation(t, d.Annotations, "nais_apm_url", tc.wantAnnotation)
			if v := findKV(d.Annotations, "summary"); v == "" {
				t.Error("missing summary annotation")
			}
			if v := findKV(d.Labels, "source"); v != "nais-apm" {
				t.Errorf("label source = %q, want nais-apm", v)
			}
			if v := findKV(d.Labels, "service"); v != "my-svc" {
				t.Errorf("label service = %q, want my-svc", v)
			}

			assertURLEncoding(t, resp)
		})
	}
}

// sloBurnExpr independently derives the expected multi-window burn-rate
// expression so the test asserts the exact windows/factor/budget math the
// handler renders, not just that it produced *some* string.
func sloBurnExpr(errSel, allSel, longWin, shortWin, budget, factor string) string {
	const calls = "traces_span_metrics_calls_total"
	ratio := func(w string) string {
		return fmt.Sprintf(`(sum(rate(%s{%s}[%s])) or vector(0)) / sum(rate(%s{%s}[%s]))`,
			calls, errSel, w, calls, allSel, w)
	}
	long := ratio(longWin) + " / " + budget
	short := ratio(shortWin) + " / " + budget
	return fmt.Sprintf(`%s * (%s >= bool %s)`, long, short, factor)
}

func TestSLOBurnRateTemplate(t *testing.T) {

	tests := []struct {
		name string
		url  string

		wantDSUID      string
		wantExpr       string
		wantName       string
		wantThreshold  float64
		wantEvaluate   string
		wantSeverity   string
		wantSLOLabel   string
		wantAnnotation string
		// substrings the expression must contain (windows/factor/budget/target math)
		wantContains []string
	}{
		{
			name:      "fast burn defaults to 99.9% target, 14.4x over 1h/5m",
			url:       "/alert-templates/slo-burn-rate?namespace=team-a&service=my-svc",
			wantDSUID: "mimir-default",
			wantExpr: sloBurnExpr(`service_name="my-svc", service_namespace="team-a", status_code="STATUS_CODE_ERROR"`,
				`service_name="my-svc", service_namespace="team-a"`,
				"1h", "5m", "0.001", "14.4"),
			wantName:       "Fast burn (14.4x) – SLO 99.9% – my-svc",
			wantThreshold:  14.4,
			wantEvaluate:   "2m",
			wantSeverity:   "critical",
			wantSLOLabel:   "99.9%",
			wantAnnotation: "/a/nais-apm-app/services/team-a/my-svc",
			wantContains:   []string{"[1h]", "[5m]", "/ 0.001", ">= bool 14.4", "or vector(0)"},
		},
		{
			name:      "slow burn with env and custom 99% target, 6x over 6h/30m",
			url:       "/alert-templates/slo-burn-rate?namespace=team-a&service=my-svc&environment=prod-gcp&window=slow&slo=0.99",
			wantDSUID: "mimir-prod-gcp",
			wantExpr: sloBurnExpr(`service_name="my-svc", service_namespace="team-a", k8s_cluster_name="prod-gcp", status_code="STATUS_CODE_ERROR"`,
				`service_name="my-svc", service_namespace="team-a", k8s_cluster_name="prod-gcp"`,
				"6h", "30m", "0.01", "6"),
			wantName:       "Slow burn (6x) – SLO 99% – my-svc (prod-gcp)",
			wantThreshold:  6,
			wantEvaluate:   "15m",
			wantSeverity:   "warning",
			wantSLOLabel:   "99%",
			wantAnnotation: "/a/nais-apm-app/services/team-a/my-svc?environment=prod-gcp",
			wantContains:   []string{"[6h]", "[30m]", "/ 0.01", ">= bool 6", "or vector(0)"},
		},
		{
			name:      "four-nines target renders 0.0001 budget",
			url:       "/alert-templates/slo-burn-rate?namespace=_&service=my-svc&slo=0.9999",
			wantDSUID: "mimir-default",
			wantExpr: sloBurnExpr(`service_name="my-svc", status_code="STATUS_CODE_ERROR"`,
				`service_name="my-svc"`,
				"1h", "5m", "0.0001", "14.4"),
			wantName:       "Fast burn (14.4x) – SLO 99.99% – my-svc",
			wantThreshold:  14.4,
			wantEvaluate:   "2m",
			wantSeverity:   "critical",
			wantSLOLabel:   "99.99%",
			wantAnnotation: "/a/nais-apm-app/services/_/my-svc",
			wantContains:   []string{"/ 0.0001", ">= bool 14.4"},
		},
		{
			name:      "invalid slo falls back to 99.9% default",
			url:       "/alert-templates/slo-burn-rate?namespace=team-a&service=my-svc&slo=not-a-number",
			wantDSUID: "mimir-default",
			wantExpr: sloBurnExpr(`service_name="my-svc", service_namespace="team-a", status_code="STATUS_CODE_ERROR"`,
				`service_name="my-svc", service_namespace="team-a"`,
				"1h", "5m", "0.001", "14.4"),
			wantName:       "Fast burn (14.4x) – SLO 99.9% – my-svc",
			wantThreshold:  14.4,
			wantEvaluate:   "2m",
			wantSeverity:   "critical",
			wantSLOLabel:   "99.9%",
			wantAnnotation: "/a/nais-apm-app/services/team-a/my-svc",
			wantContains:   []string{"/ 0.001", ">= bool 14.4"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			app := newAlertTemplateApp(t)
			w := serveAlertTemplate(t, app, tc.url)
			resp := decodeAlertTemplate(t, w)
			d := resp.Defaults

			if d.Name != tc.wantName {
				t.Errorf("name = %q, want %q", d.Name, tc.wantName)
			}
			if d.EvaluateFor != tc.wantEvaluate {
				t.Errorf("evaluateFor = %q, want %q", d.EvaluateFor, tc.wantEvaluate)
			}
			if d.Condition != "C" {
				t.Errorf("condition = %q, want C", d.Condition)
			}
			if len(d.Queries) != 3 {
				t.Fatalf("expected 3 queries, got %d", len(d.Queries))
			}
			qa := d.Queries[0]
			if qa.DatasourceUID != tc.wantDSUID {
				t.Errorf("datasourceUid = %q, want %q", qa.DatasourceUID, tc.wantDSUID)
			}
			expr, _ := qa.Model["expr"].(string)
			if expr != tc.wantExpr {
				t.Errorf("expr =\n  %s\nwant\n  %s", expr, tc.wantExpr)
			}
			for _, sub := range tc.wantContains {
				if !strings.Contains(expr, sub) {
					t.Errorf("expr missing %q:\n  %s", sub, expr)
				}
			}
			if got := thresholdParam(t, d.Queries[2]); got != tc.wantThreshold {
				t.Errorf("threshold = %v, want %v", got, tc.wantThreshold)
			}
			if v := findKV(d.Labels, "severity"); v != tc.wantSeverity {
				t.Errorf("severity label = %q, want %q", v, tc.wantSeverity)
			}
			if v := findKV(d.Labels, "slo"); v != tc.wantSLOLabel {
				t.Errorf("slo label = %q, want %q", v, tc.wantSLOLabel)
			}
			if v := findKV(d.Labels, "source"); v != "nais-apm" {
				t.Errorf("source label = %q, want nais-apm", v)
			}
			assertAnnotation(t, d.Annotations, "nais_apm_url", tc.wantAnnotation)
			if v := findKV(d.Annotations, "summary"); v == "" {
				t.Error("missing summary annotation")
			}
			assertURLEncoding(t, resp)
		})
	}
}

func TestSLOBurnRateValidation(t *testing.T) {
	tests := []struct {
		name       string
		url        string
		wantStatus int
	}{
		{"invalid window rejected", "/alert-templates/slo-burn-rate?service=my-svc&window=medium", http.StatusBadRequest},
		{"missing service rejected", "/alert-templates/slo-burn-rate?namespace=team-a", http.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			app := newAlertTemplateApp(t)
			w := serveAlertTemplate(t, app, tc.url)
			if w.Code != tc.wantStatus {
				t.Fatalf("expected %d, got %d: %s", tc.wantStatus, w.Code, w.Body.String())
			}
		})
	}
}

func TestSLOBurnRateDatasourceNotConfigured(t *testing.T) {
	app := newTestApp(t, "http://prom.invalid", defaultCaps())
	w := serveAlertTemplate(t, app, "/alert-templates/slo-burn-rate?service=my-svc")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d: %s", w.Code, w.Body.String())
	}
}

func TestParseSloTarget(t *testing.T) {
	tests := []struct {
		raw  string
		want float64
	}{
		{"", 0.999},
		{"0.99", 0.99},
		{"0.9999", 0.9999},
		{"not-a-number", 0.999},
		{"1.5", 0.999},  // out of range
		{"0.1", 0.999},  // below min
		{"-0.5", 0.999}, // negative
	}
	for _, tc := range tests {
		if got := parseSloTarget(tc.raw); got != tc.want {
			t.Errorf("parseSloTarget(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}
}

func TestAlertTemplateDatasourceNotConfigured(t *testing.T) {
	tests := []struct {
		name string
		url  string
	}{
		{"error-rate without metrics datasource", "/alert-templates/error-rate?service=my-svc"},
		{"exception-spike without logs datasource", "/alert-templates/exception-spike?service=my-svc&hash=abc123"},
		{"web-vitals without metrics datasource", "/alert-templates/web-vitals?service=my-svc"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			app := newTestApp(t, "http://prom.invalid", defaultCaps()) // no datasource settings
			w := serveAlertTemplate(t, app, tc.url)
			if w.Code != http.StatusServiceUnavailable {
				t.Fatalf("expected 503, got %d: %s", w.Code, w.Body.String())
			}
		})
	}
}

// TestAlertTemplateGolden pins the full RuleFormValues `defaults=` shape for
// every alert-template kind against a committed golden snapshot (#77). The
// `defaults=` object mirrors Grafana's INTERNAL, unversioned RuleFormValues
// type; if that shape ever drifts (a renamed/removed/added field), the snapshot
// diff fails the build here instead of silently producing a blank rule form in
// Grafana. Regenerate intentionally with `-update` after eyeballing the diff.
//
// Alongside the snapshot, each kind is checked against the structural contract
// that must hold regardless of the exact query strings (assertRuleFormContract):
// required key set, condition == "C", C among the query refIds, the threshold
// living in the C threshold expression, and a resolved datasource UID.
func TestAlertTemplateGolden(t *testing.T) {
	kinds := []struct {
		name      string
		url       string
		wantDSUID string
	}{
		{
			name:      "error-rate",
			url:       "/alert-templates/error-rate?namespace=team-a&service=my-svc&environment=prod-gcp",
			wantDSUID: "mimir-prod-gcp",
		},
		{
			name:      "exception-spike",
			url:       "/alert-templates/exception-spike?namespace=team-a&service=my-svc&environment=prod-gcp&hash=abc123&fingerprint=v1:9f2ab31c04d7e655",
			wantDSUID: "loki-prod-gcp",
		},
		{
			name:      "web-vitals",
			url:       "/alert-templates/web-vitals?namespace=team-a&service=my-svc&environment=prod-gcp",
			wantDSUID: "mimir-prod-gcp",
		},
		{
			name:      "new-exceptions",
			url:       "/alert-templates/new-exceptions?namespace=team-a&service=my-svc&environment=prod-gcp",
			wantDSUID: "loki-prod-gcp",
		},
		{
			name:      "slo-burn-rate",
			url:       "/alert-templates/slo-burn-rate?namespace=team-a&service=my-svc&environment=prod-gcp&window=fast",
			wantDSUID: "mimir-prod-gcp",
		},
	}

	for _, tc := range kinds {
		t.Run(tc.name, func(t *testing.T) {
			app := newAlertTemplateApp(t)
			w := serveAlertTemplate(t, app, tc.url)
			resp := decodeAlertTemplate(t, w)

			assertRuleFormContract(t, resp.Defaults, tc.wantDSUID)

			// Snapshot the exact object Grafana receives (indented for a
			// reviewable diff). Re-marshal from the decoded struct so the golden
			// is independent of HTTP-level whitespace.
			got, err := json.MarshalIndent(resp.Defaults, "", "  ")
			if err != nil {
				t.Fatalf("marshal defaults: %v", err)
			}
			got = append(got, '\n')

			golden := filepath.Join("testdata", "alerttemplates", tc.name+".golden.json")
			if *updateGolden {
				if err := os.MkdirAll(filepath.Dir(golden), 0o755); err != nil {
					t.Fatalf("mkdir golden dir: %v", err)
				}
				if err := os.WriteFile(golden, got, 0o644); err != nil {
					t.Fatalf("write golden: %v", err)
				}
				return
			}

			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatalf("read golden (%s) — run `go test ./pkg/plugin -run TestAlertTemplateGolden -update`: %v", golden, err)
			}
			if string(got) != string(want) {
				t.Errorf("RuleFormValues shape drifted from golden %s.\n"+
					"If this change is intentional, re-run with -update and review the diff.\n--- got ---\n%s\n--- want ---\n%s",
					golden, got, want)
			}
		})
	}
}

// assertRuleFormContract asserts the version-fragile invariants of the
// RuleFormValues `defaults=` object that must hold for Grafana's rule editor to
// pre-fill correctly, independent of the exact PromQL/LogQL query strings.
func assertRuleFormContract(t *testing.T, d ruleFormDefaults, wantDSUID string) {
	t.Helper()

	// Required key set (a missing/renamed field breaks the merge silently).
	if d.Type != "grafana" {
		t.Errorf("type = %q, want %q", d.Type, "grafana")
	}
	if d.Name == "" {
		t.Error("name is empty")
	}
	if d.EvaluateFor == "" {
		t.Error("evaluateFor is empty")
	}
	if len(d.Queries) < 2 {
		t.Fatalf("expected at least data+threshold queries, got %d", len(d.Queries))
	}
	if findKV(d.Annotations, "summary") == "" {
		t.Error("missing summary annotation")
	}
	if findKV(d.Annotations, "nais_apm_url") == "" {
		t.Error("missing nais_apm_url annotation")
	}
	if findKV(d.Labels, "source") != "nais-apm" {
		t.Errorf("label source = %q, want nais-apm", findKV(d.Labels, "source"))
	}

	// condition == "C" and C is among the query refIds.
	if d.Condition != "C" {
		t.Errorf("condition = %q, want C", d.Condition)
	}
	refIDs := map[string]alertQuery{}
	for _, q := range d.Queries {
		refIDs[q.RefID] = q
	}
	condQuery, ok := refIDs[d.Condition]
	if !ok {
		t.Fatalf("condition %q not among query refIds %v", d.Condition, refIDKeys(refIDs))
	}

	// The threshold lives in the C threshold expression (a Grafana-native
	// server-side expression), NOT baked into the data query's PromQL/LogQL.
	if condQuery.DatasourceUID != expressionDatasourceUID {
		t.Errorf("condition query datasourceUid = %q, want %q (server-side expression)", condQuery.DatasourceUID, expressionDatasourceUID)
	}
	if condQuery.Model["type"] != "threshold" {
		t.Errorf("condition query model.type = %v, want threshold", condQuery.Model["type"])
	}
	if _, hasExpr := condQuery.Model["expr"]; hasExpr {
		t.Error("condition (threshold) query must not carry a PromQL/LogQL expr")
	}
	// The data query A resolves to the real datasource (UID resolution seam).
	dataQ, ok := refIDs["A"]
	if !ok {
		t.Fatal("no refId A data query")
	}
	if dataQ.DatasourceUID != wantDSUID {
		t.Errorf("data query datasourceUid = %q, want %q", dataQ.DatasourceUID, wantDSUID)
	}
	if dataQ.DatasourceUID == "" || dataQ.DatasourceUID == expressionDatasourceUID {
		t.Errorf("data query datasourceUid = %q, want a resolved datasource UID", dataQ.DatasourceUID)
	}
}

func refIDKeys(m map[string]alertQuery) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// assertURLEncoding round-trips the returned URL: the defaults query param
// must decode back to exactly the marshalled defaults object.
func assertURLEncoding(t *testing.T, resp alertTemplateResponse) {
	t.Helper()

	if !strings.HasPrefix(resp.URL, "/alerting/new?defaults=") {
		t.Fatalf("url = %q, want /alerting/new?defaults=... prefix", resp.URL)
	}
	u, err := url.Parse(resp.URL)
	if err != nil {
		t.Fatalf("returned url does not parse: %s", err)
	}
	decoded := u.Query().Get("defaults")
	if decoded == "" {
		t.Fatal("defaults query param missing or empty after decoding")
	}

	want, err := json.Marshal(resp.Defaults)
	if err != nil {
		t.Fatalf("re-marshal defaults: %s", err)
	}
	if decoded != string(want) {
		t.Errorf("URL-decoded defaults differ from defaults object:\n  decoded: %s\n  want:    %s", decoded, want)
	}

	// The encoded portion must survive strict decoding on its own.
	rawEncoded := strings.TrimPrefix(resp.URL, "/alerting/new?defaults=")
	unescaped, err := url.QueryUnescape(rawEncoded)
	if err != nil {
		t.Fatalf("defaults param is not valid query-encoding: %s", err)
	}
	if unescaped != string(want) {
		t.Errorf("QueryUnescape(defaults) != marshalled defaults")
	}
}

func assertAnnotation(t *testing.T, annotations []alertKeyValue, key, want string) {
	t.Helper()
	got := findKV(annotations, key)
	if got != want {
		t.Errorf("annotation %s = %q, want %q", key, got, want)
	}
}

func findKV(kvs []alertKeyValue, key string) string {
	for _, kv := range kvs {
		if kv.Key == key {
			return kv.Value
		}
	}
	return ""
}

func thresholdParam(t *testing.T, q alertQuery) float64 {
	t.Helper()
	conditions, ok := q.Model["conditions"].([]any)
	if !ok || len(conditions) == 0 {
		t.Fatalf("threshold query has no conditions: %+v", q.Model)
	}
	cond, _ := conditions[0].(map[string]any)
	evaluator, _ := cond["evaluator"].(map[string]any)
	params, _ := evaluator["params"].([]any)
	if len(params) == 0 {
		t.Fatalf("threshold evaluator has no params: %+v", evaluator)
	}
	v, _ := params[0].(float64)
	return v
}
