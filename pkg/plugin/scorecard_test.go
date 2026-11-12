package plugin

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// scorecardFixture controls which observability signals the fake backends
// report for the probed service.
type scorecardFixture struct {
	spanMetrics        bool
	traces             bool
	logs               bool
	runtime            bool
	browser            bool
	alertRule          bool
	mimirRules         []queries.Rule
	mimirStatus        int
	grafanaRulesStatus int
	sdkLanguage        string                    // telemetry_sdk_language answered by the language probe ("" → no series)
	naisResponse       func(query string) string // nil → console unconfigured
}

// newScorecardApp wires fake Prometheus, Grafana-proxy (Tempo/Loki/rules) and
// optionally nais Console servers into an App.
func newScorecardApp(t *testing.T, fx scorecardFixture) *App {
	t.Helper()

	// Fake Mimir: instant queries answered by substring, /api/v1/rules empty.
	prom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/api/v1/rules") {
			if fx.mimirStatus != 0 {
				http.Error(w, "rules unavailable", fx.mimirStatus)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "success",
				"data":   queries.RulesResponse{Groups: []queries.RuleGroup{{Rules: fx.mimirRules}}},
			})
			return
		}
		query := r.URL.Query().Get("query")
		// The SDK-language probe also mentions the calls metric, so match it first.
		if strings.Contains(query, "telemetry_sdk_language") {
			result := `[]`
			if fx.sdkLanguage != "" {
				result = `[{"metric":{"telemetry_sdk_language":"` + fx.sdkLanguage + `"},"value":[1700000000,"1"]}]`
			}
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":` + result + `}}`))
			return
		}
		hit := false
		switch {
		case strings.Contains(query, "calls_total"):
			hit = fx.spanMetrics
		case strings.Contains(query, "jvm_"):
			hit = fx.runtime
		case strings.Contains(query, "faro_"):
			hit = fx.browser
		}
		result := `[]`
		if hit {
			result = `[{"metric":{},"value":[1700000000,"3"]}]`
		}
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":` + result + `}}`))
	}))
	t.Cleanup(prom.Close)

	// Fake Grafana: datasource proxy for Tempo search + Loki index/stats, and
	// the Grafana-managed rules API.
	grafana := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "/proxy/uid/tempo/api/search"):
			if fx.traces {
				_, _ = w.Write([]byte(`{"traces":[{"traceID":"abc"}]}`))
			} else {
				_, _ = w.Write([]byte(`{"traces":[]}`))
			}
		case strings.Contains(r.URL.Path, "/proxy/uid/loki/loki/api/v1/index/stats"):
			if fx.logs {
				_, _ = w.Write([]byte(`{"streams":4,"chunks":10,"entries":100,"bytes":1000}`))
			} else {
				_, _ = w.Write([]byte(`{"streams":0,"chunks":0,"entries":0,"bytes":0}`))
			}
		case strings.Contains(r.URL.Path, "/api/prometheus/grafana/api/v1/rules"):
			if fx.grafanaRulesStatus != 0 {
				http.Error(w, "rules unavailable", fx.grafanaRulesStatus)
				return
			}
			groups := `[]`
			if fx.alertRule {
				groups = `[{"name":"g","file":"team-a","rules":[
					{"type":"alerting","name":"my-app error rate","query":"sum(rate(calls_total{service_name=\"my-app\"}[5m]))","labels":{}}
				]}]`
			}
			_, _ = w.Write([]byte(`{"status":"success","data":{"groups":` + groups + `}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(grafana.Close)

	app := &App{
		otelCfg:      otelconfig.Default(),
		respCache:    newResponseCache(),
		promClient:   queries.NewPrometheusClient(prom.URL, ""),
		healthClient: &http.Client{Timeout: 5 * time.Second},
		grafanaURL:   grafana.URL,
		settings: queries.PluginSettings{
			TracesDataSource: queries.EnvAwareDataSource{UID: "tempo"},
			LogsDataSource:   queries.EnvAwareDataSource{UID: "loki"},
		},
	}
	app.capCache = &cachedCapabilities{caps: defaultCaps(), fetchedAt: time.Now()}

	if fx.naisResponse != nil {
		nais := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			var payload struct {
				Query string `json:"query"`
			}
			_ = json.Unmarshal(body, &payload)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(fx.naisResponse(payload.Query)))
		}))
		t.Cleanup(nais.Close)
		app.settings.NaisAPIURL = nais.URL
		app.naisToken = "tok"
	}
	return app
}

func getScorecard(t *testing.T, app *App) ScorecardResponse {
	const namespace, service = "team-a", "my-app"
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/services/"+namespace+"/"+service+"/scorecard", nil)
	req.SetPathValue("namespace", namespace)
	req.SetPathValue("service", service)
	w := httptest.NewRecorder()
	app.handleScorecard(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp ScorecardResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	return resp
}

func TestScorecardReadinessScore(t *testing.T) {
	cases := []struct {
		name      string
		fx        scorecardFixture
		wantScore int
		wantTotal int
		wantOK    map[string]bool
		wantNA    map[string]bool
	}{
		{
			name:      "nothing instrumented",
			fx:        scorecardFixture{},
			wantScore: 0,
			wantTotal: 6,
		},
		{
			name:      "fully instrumented",
			fx:        scorecardFixture{spanMetrics: true, traces: true, logs: true, runtime: true, browser: true, alertRule: true},
			wantScore: 6,
			wantTotal: 6,
		},
		{
			name:      "backend service, unknown language: Faro stays actionable",
			fx:        scorecardFixture{spanMetrics: true, traces: true, logs: true, runtime: true},
			wantScore: 4,
			wantTotal: 6,
			wantOK: map[string]bool{
				"spanMetrics": true, "traces": true, "logs": true,
				"runtimeMetrics": true, "browserTelemetry": false, "alertRules": false,
			},
		},
		{
			name:      "pure JVM backend: Faro not applicable, excluded from score",
			fx:        scorecardFixture{spanMetrics: true, traces: true, logs: true, runtime: true, sdkLanguage: "java"},
			wantScore: 4,
			wantTotal: 5,
			wantOK: map[string]bool{
				"spanMetrics": true, "traces": true, "logs": true,
				"runtimeMetrics": true, "browserTelemetry": false, "alertRules": false,
			},
			wantNA: map[string]bool{"browserTelemetry": true},
		},
		{
			name:      "node service: Faro stays applicable (SSR/BFF ambiguity)",
			fx:        scorecardFixture{spanMetrics: true, sdkLanguage: "nodejs"},
			wantScore: 1,
			wantTotal: 6,
			wantOK:    map[string]bool{"browserTelemetry": false},
			wantNA:    map[string]bool{"browserTelemetry": false},
		},
		{
			name:      "JVM service WITH faro data: check passes and stays applicable",
			fx:        scorecardFixture{browser: true, sdkLanguage: "java"},
			wantScore: 1,
			wantTotal: 6,
			wantOK:    map[string]bool{"browserTelemetry": true},
			wantNA:    map[string]bool{"browserTelemetry": false},
		},
		{
			name:      "alert rule via grafana-managed rules",
			fx:        scorecardFixture{alertRule: true},
			wantScore: 1,
			wantTotal: 6,
			wantOK:    map[string]bool{"alertRules": true},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := newScorecardApp(t, tc.fx)
			resp := getScorecard(t, app)

			if resp.Readiness.Total != tc.wantTotal {
				t.Fatalf("total = %d, want %d", resp.Readiness.Total, tc.wantTotal)
			}
			if resp.Readiness.Score != tc.wantScore {
				t.Errorf("score = %d, want %d (checks: %+v)", resp.Readiness.Score, tc.wantScore, resp.Readiness.Checks)
			}
			byKey := map[string]ScorecardCheck{}
			for _, c := range resp.Readiness.Checks {
				byKey[c.Key] = c
				if c.Label == "" || c.Hint == "" {
					t.Errorf("check %q missing label/hint", c.Key)
				}
			}
			for key, want := range tc.wantOK {
				if byKey[key].OK != want {
					t.Errorf("check %q ok = %v, want %v", key, byKey[key].OK, want)
				}
			}
			for key, want := range tc.wantNA {
				if byKey[key].NotApplicable != want {
					t.Errorf("check %q notApplicable = %v, want %v", key, byKey[key].NotApplicable, want)
				}
			}
		})
	}
}

func TestScorecardAlertRulesBeyondFormerScanLimit(t *testing.T) {
	for _, source := range []string{"mimir", "grafana"} {
		t.Run(source, func(t *testing.T) {
			rules := make([]queries.Rule, 5001)
			for i := range rules {
				rules[i] = queries.Rule{Type: "recording", Query: `up{service_name="my-app"}`}
			}
			if source == "mimir" {
				rules = append(rules, queries.Rule{
					Type: "alerting", Name: "MyAppDown", State: "inactive",
					Labels: map[string]string{"service_name": "my-app"},
				})
			}
			app := newScorecardApp(t, scorecardFixture{mimirRules: rules, alertRule: source == "grafana"})
			response := getScorecard(t, app)
			for _, check := range response.Readiness.Checks {
				if check.Key == "alertRules" && (!check.OK || check.Unavailable) {
					t.Fatalf("expected inactive %s rule to pass readiness: %+v", source, check)
				}
			}
			if response.Readiness.Score != 1 {
				t.Fatalf("score = %d, want 1", response.Readiness.Score)
			}
		})
	}
}

func TestScorecardAlertRulesUnavailable(t *testing.T) {
	tests := []struct {
		name            string
		fixture         scorecardFixture
		wantOK          bool
		wantUnavailable bool
	}{
		{name: "both sources empty"},
		{name: "mimir failed", fixture: scorecardFixture{mimirStatus: http.StatusServiceUnavailable}, wantUnavailable: true},
		{name: "grafana failed", fixture: scorecardFixture{grafanaRulesStatus: http.StatusForbidden}, wantUnavailable: true},
		{name: "both failed", fixture: scorecardFixture{
			mimirStatus: http.StatusServiceUnavailable, grafanaRulesStatus: http.StatusForbidden,
		}, wantUnavailable: true},
		{name: "grafana match despite mimir failure", fixture: scorecardFixture{
			mimirStatus: http.StatusServiceUnavailable, alertRule: true,
		}, wantOK: true},
		{name: "mimir match despite grafana failure", fixture: scorecardFixture{
			grafanaRulesStatus: http.StatusForbidden,
			mimirRules:         []queries.Rule{{Type: "alerting", Labels: map[string]string{"service": "my-app"}}},
		}, wantOK: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response := getScorecard(t, newScorecardApp(t, tt.fixture))
			for _, check := range response.Readiness.Checks {
				if check.Key != "alertRules" {
					continue
				}
				if check.OK != tt.wantOK || check.Unavailable != tt.wantUnavailable {
					t.Fatalf("unexpected alert readiness: %+v", check)
				}
				if check.Unavailable && (strings.Contains(check.Hint, "No alert rule") || !strings.Contains(check.Hint, "Unable to check")) {
					t.Fatalf("unavailable check must not claim there are no rules: %s", check.Hint)
				}
			}
		})
	}
}

func TestScorecardAndAlertsShareRuleCache(t *testing.T) {
	var requests atomic.Int32
	var hasRule atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !strings.HasSuffix(r.URL.Path, "/api/v1/rules") {
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
			return
		}
		requests.Add(1)
		rules := []queries.Rule{}
		if hasRule.Load() {
			rules = append(rules, queries.Rule{
				Type: "alerting", Name: "MyAppDown", State: "inactive",
				Labels: map[string]string{"service": "my-app"},
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "success",
			"data":   queries.RulesResponse{Groups: []queries.RuleGroup{{Rules: rules}}},
		})
	}))
	defer server.Close()
	app := newScorecardApp(t, scorecardFixture{})
	app.promClient = queries.NewPrometheusClient(server.URL, "")
	app.grafanaURL = server.URL
	app.serviceToken = "service-token"

	getAlerts := func() ServiceAlertsResponse {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/services/team-a/my-app/alerts", nil)
		req.SetPathValue("namespace", "team-a")
		req.SetPathValue("service", "my-app")
		w := httptest.NewRecorder()
		app.handleServiceAlerts(w, req)
		var response ServiceAlertsResponse
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response
	}
	if response := getScorecard(t, app); response.Readiness.Score != 0 {
		t.Fatalf("initial score = %d, want 0", response.Readiness.Score)
	}
	if response := getAlerts(); len(response.Rules) != 0 {
		t.Fatalf("unexpected initial rules: %+v", response)
	}
	if got := requests.Load(); got != 2 {
		t.Fatalf("both views should share one fetch per source, got %d requests", got)
	}

	hasRule.Store(true)
	app.alertRulesMu.Lock()
	for key, entry := range app.alertRulesCache {
		entry.fetchedAt = time.Now().Add(-time.Minute)
		app.alertRulesCache[key] = entry
	}
	app.alertRulesMu.Unlock()

	if response := getAlerts(); len(response.Rules) != 1 {
		t.Fatalf("expected the new rule deduplicated across sources: %+v", response)
	}
	for range 2 {
		if response := getScorecard(t, app); response.Readiness.Score != 1 {
			t.Fatalf("cached base scorecard must reflect refreshed rules exactly once: %+v", response.Readiness)
		}
	}
	if got := requests.Load(); got != 4 {
		t.Fatalf("expected one refresh per source, got %d requests", got)
	}
}

func TestScorecardConsoleUnconfigured(t *testing.T) {
	app := newScorecardApp(t, scorecardFixture{spanMetrics: true})
	resp := getScorecard(t, app)

	if resp.Console.Configured {
		t.Error("console.configured = true without nais API settings")
	}
	if resp.Console.TeamSlug != "" || resp.Console.RepositoryURL != "" || len(resp.Console.Ingresses) != 0 {
		t.Errorf("unconfigured console leaked fields: %+v", resp.Console)
	}
	// Readiness must still be computed.
	if resp.Readiness.Score != 1 || resp.Readiness.Total != 6 {
		t.Errorf("readiness = %d/%d, want 1/6", resp.Readiness.Score, resp.Readiness.Total)
	}
}

const consoleTeamJSON = `{"data":{"team":{"slug":"team-a","slackChannel":"#team-a-alerts"}}}`
const consoleAppsJSON = `{"data":{"team":{"applications":{"nodes":[
	{"name":"other-app","ingresses":[{"url":"https://other.nav.no"}]},
	{"name":"my-app","ingresses":[{"url":"https://my-app.nav.no"},{"url":"https://my-app.intern.nav.no"}]}
]}}}}`
const consoleDeploysJSON = `{"data":{"deployments":{"nodes":[{
	"id":"dep-1","createdAt":"2026-07-03T10:00:00Z","environmentName":"prod-gcp",
	"commitSha":"abc1234","triggerUrl":"https://github.com/navikt/my-app/actions/runs/42","teamSlug":"team-a",
	"resources":{"nodes":[{"kind":"Application","name":"my-app"}]},
	"statuses":{"nodes":[{"state":"SUCCESS"}]}
}]}}}`

func TestScorecardConsoleEnrichment(t *testing.T) {
	app := newScorecardApp(t, scorecardFixture{
		naisResponse: func(query string) string {
			switch {
			case strings.Contains(query, "slackChannel"):
				return consoleTeamJSON
			case strings.Contains(query, "applications"):
				return consoleAppsJSON
			case strings.Contains(query, "deployments"):
				return consoleDeploysJSON
			}
			return `{"errors":[{"message":"unknown query"}]}`
		},
	})
	resp := getScorecard(t, app)

	c := resp.Console
	if !c.Configured {
		t.Fatal("console.configured = false")
	}
	if c.TeamSlug != "team-a" || c.SlackChannel != "#team-a-alerts" {
		t.Errorf("team facts = %q/%q, want team-a/#team-a-alerts", c.TeamSlug, c.SlackChannel)
	}
	if c.RepositoryURL != "https://github.com/navikt/my-app" {
		t.Errorf("repositoryUrl = %q, want derived github repo", c.RepositoryURL)
	}
	if len(c.Ingresses) != 2 || c.Ingresses[0] != "https://my-app.nav.no" {
		t.Errorf("ingresses = %v, want my-app's two URLs", c.Ingresses)
	}
}

func TestScorecardConsolePerFieldDegradation(t *testing.T) {
	// The deployed schema lacks the applications listing (GraphQL error):
	// team + repo facts must still arrive, ingresses silently omitted.
	app := newScorecardApp(t, scorecardFixture{
		naisResponse: func(query string) string {
			switch {
			case strings.Contains(query, "slackChannel"):
				return consoleTeamJSON
			case strings.Contains(query, "applications"):
				return `{"errors":[{"message":"Cannot query field \"applications\" on type \"Team\""}]}`
			case strings.Contains(query, "deployments"):
				return consoleDeploysJSON
			}
			return `{"errors":[{"message":"unknown query"}]}`
		},
	})
	resp := getScorecard(t, app)

	c := resp.Console
	if !c.Configured {
		t.Fatal("console.configured = false")
	}
	if c.TeamSlug != "team-a" {
		t.Errorf("teamSlug = %q, want team-a despite applications degradation", c.TeamSlug)
	}
	if c.RepositoryURL != "https://github.com/navikt/my-app" {
		t.Errorf("repositoryUrl = %q, want derived repo despite applications degradation", c.RepositoryURL)
	}
	if len(c.Ingresses) != 0 {
		t.Errorf("ingresses = %v, want omitted", c.Ingresses)
	}
}

func TestRuleMentionsService(t *testing.T) {
	cases := []struct {
		name    string
		rule    queries.Rule
		service string
		want    bool
	}{
		{"quoted in promql", queries.Rule{Query: `rate(calls_total{service_name="my-app"}[5m])`}, "my-app", true},
		{"escaped quotes (grafana json)", queries.Rule{Query: `{"expr":"up{app=\"my-app\"}"}`}, "my-app", true},
		{"label match", queries.Rule{Labels: map[string]string{"app": "my-app"}}, "my-app", true},
		{"substring of other service does not match", queries.Rule{Query: `rate(calls_total{service_name="my-app-worker"}[5m])`}, "my-app", false},
		{"no mention", queries.Rule{Query: `up == 0`, Labels: map[string]string{"team": "x"}}, "my-app", false},
		{"empty service", queries.Rule{Query: `""`}, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ruleMentionsService(tc.rule, tc.service); got != tc.want {
				t.Errorf("ruleMentionsService() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestDeriveRepoURL(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"https://github.com/navikt/my-app/actions/runs/42", "https://github.com/navikt/my-app"},
		{"https://github.com/navikt/my-app/actions/runs/42/attempts/2", "https://github.com/navikt/my-app"},
		{"", ""},
		{"http://github.com/navikt/my-app/actions/runs/1", ""}, // not https
		{"https://example.com/no-actions-path", ""},
		{"https://github.com/actions/runs/1", ""}, // owner/repo missing
	}
	for _, tc := range cases {
		if got := deriveRepoURL(tc.in); got != tc.want {
			t.Errorf("deriveRepoURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
