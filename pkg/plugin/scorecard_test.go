package plugin

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// scorecardFixture controls which observability signals the fake backends
// report for the probed service.
type scorecardFixture struct {
	spanMetrics  bool
	traces       bool
	logs         bool
	runtime      bool
	browser      bool
	alertRule    bool
	naisResponse func(query string) string // nil → console unconfigured
}

// newScorecardApp wires fake Prometheus, Grafana-proxy (Tempo/Loki/rules) and
// optionally nais Console servers into an App.
func newScorecardApp(t *testing.T, fx scorecardFixture) *App {
	t.Helper()

	// Fake Mimir: instant queries answered by substring, /api/v1/rules empty.
	prom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/api/v1/rules") {
			_, _ = w.Write([]byte(`{"status":"success","data":{"groups":[]}}`))
			return
		}
		query := r.URL.Query().Get("query")
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
		wantOK    map[string]bool
	}{
		{
			name:      "nothing instrumented",
			fx:        scorecardFixture{},
			wantScore: 0,
		},
		{
			name:      "fully instrumented",
			fx:        scorecardFixture{spanMetrics: true, traces: true, logs: true, runtime: true, browser: true, alertRule: true},
			wantScore: 6,
		},
		{
			name:      "backend service without frontend or alerts",
			fx:        scorecardFixture{spanMetrics: true, traces: true, logs: true, runtime: true},
			wantScore: 4,
			wantOK: map[string]bool{
				"spanMetrics": true, "traces": true, "logs": true,
				"runtimeMetrics": true, "browserTelemetry": false, "alertRules": false,
			},
		},
		{
			name:      "alert rule via grafana-managed rules",
			fx:        scorecardFixture{alertRule: true},
			wantScore: 1,
			wantOK:    map[string]bool{"alertRules": true},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := newScorecardApp(t, tc.fx)
			resp := getScorecard(t, app)

			if resp.Readiness.Total != 6 {
				t.Fatalf("total = %d, want 6", resp.Readiness.Total)
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
		})
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
