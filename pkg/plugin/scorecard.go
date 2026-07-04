package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// Service scorecard (M7): ownership/runbook/repo enrichment from the nais
// Console GraphQL API plus an "observability readiness" score computed from
// signals the plugin already probes (span metrics, traces, logs, runtime
// metrics, browser telemetry, alert rules).
//
// Console enrichment degrades per-field: each Console fact is fetched with
// its own small GraphQL query, so a deployed schema lacking one field only
// omits that field. When no nais API URL/token is configured the console
// section is {configured:false} and the UI shows nothing — silent, not an
// error (the local/dev case).

const (
	// scorecardCacheTTL is deliberately long: the checks are presence probes
	// whose answers change on deploy cadence, not query cadence.
	scorecardCacheTTL = 5 * time.Minute
	// scorecardProbeTimeout bounds each individual readiness probe.
	scorecardProbeTimeout = 10 * time.Second
	// scorecardTraceLookback is the window the Tempo search probe scans.
	scorecardTraceLookback = time.Hour
	// maxScorecardRuleScan caps how many alert rules the "has alert rules"
	// check inspects — rulers can hold tens of thousands of rules fleet-wide.
	maxScorecardRuleScan = 5000
	// scorecardConsoleAppsPageSize caps the team applications listing used to
	// find this service's ingresses.
	scorecardConsoleAppsPageSize = 100
	// maxScorecardIngresses caps ingress links returned to the UI.
	maxScorecardIngresses = 10
)

// ScorecardCheck is one observability readiness check with an enablement hint.
type ScorecardCheck struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	OK    bool   `json:"ok"`
	// Hint says how to enable the capability (one sentence, nais-flavored).
	Hint string `json:"hint"`
}

// ScorecardReadiness is the computed observability readiness score.
type ScorecardReadiness struct {
	// Score is the number of passing checks; the fraction is Score/Total.
	Score  int              `json:"score"`
	Total  int              `json:"total"`
	Checks []ScorecardCheck `json:"checks"`
}

// ScorecardConsole carries ownership enrichment from the nais Console API.
// All fields except Configured are best-effort and omitted when the deployed
// schema (or the data) lacks them.
type ScorecardConsole struct {
	Configured    bool     `json:"configured"`
	TeamSlug      string   `json:"teamSlug,omitempty"`
	SlackChannel  string   `json:"slackChannel,omitempty"`
	RepositoryURL string   `json:"repositoryUrl,omitempty"`
	Ingresses     []string `json:"ingresses,omitempty"`
}

// ScorecardResponse is the /scorecard payload.
type ScorecardResponse struct {
	Readiness ScorecardReadiness `json:"readiness"`
	Console   ScorecardConsole   `json:"console"`
}

// scorecardResponseCache lazily builds the dedicated long-TTL cache. Kept
// separate from respCache so the aggressive TTL doesn't leak into the
// query-shaped endpoints sharing that cache.
func (a *App) scorecardResponseCache() *responseCache {
	a.scorecardOnce.Do(func() {
		c := newResponseCache()
		c.ttl = scorecardCacheTTL
		a.scorecardCache = c
	})
	return a.scorecardCache
}

// handleScorecard returns the service scorecard.
// GET /services/{namespace}/{service}/scorecard?environment=
func (a *App) handleScorecard(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	namespace, service := parseServiceRef(req)
	if !requireServiceParam(w, service) {
		return
	}
	env := parseEnvironment(req)

	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("scorecard", orgID, namespace, service, env)
	headers := req.Header.Clone()

	cache := a.scorecardResponseCache()
	if cached, ok := cache.get(ck); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Cache", "HIT")
		_, _ = w.Write(cached)
		return
	}
	data, err := cache.getOrCompute(ck, func() (any, error) {
		return a.computeScorecard(ctx, headers, namespace, service, env), nil
	})
	if err != nil {
		http.Error(w, "computing scorecard failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}

func (a *App) computeScorecard(ctx context.Context, headers http.Header, namespace, service, env string) ScorecardResponse {
	var (
		wg        sync.WaitGroup
		readiness ScorecardReadiness
		console   ScorecardConsole
	)
	wg.Add(2)
	go func() { defer wg.Done(); readiness = a.computeReadiness(ctx, headers, namespace, service, env) }()
	go func() { defer wg.Done(); console = a.fetchConsoleEnrichment(ctx, namespace, service) }()
	wg.Wait()
	return ScorecardResponse{Readiness: readiness, Console: console}
}

// ---------------------------------------------------------------------------
// Observability readiness
// ---------------------------------------------------------------------------

func (a *App) computeReadiness(ctx context.Context, headers http.Header, namespace, service, env string) ScorecardReadiness {
	now := time.Now()
	token := a.resolveServiceToken(ctx)

	// Fixed order and fixed slots: each goroutine writes only its own index.
	checks := []ScorecardCheck{
		{Key: "spanMetrics", Label: "Span metrics (RED)",
			Hint: "Enable auto-instrumentation in your nais manifest (spec.observability.autoInstrumentation) so traces produce RED span metrics."},
		{Key: "traces", Label: "Traces in Tempo",
			Hint: "Export OTLP traces to the collector — nais auto-instrumentation does this out of the box."},
		{Key: "logs", Label: "Logs in Loki",
			Hint: "Ship logs to Loki with spec.observability.logging.destinations: [loki] in your nais manifest."},
		{Key: "runtimeMetrics", Label: "Runtime metrics",
			Hint: "Runtime metrics (JVM/Node.js/Go/process) arrive with the OTel agent — enable auto-instrumentation for your runtime."},
		{Key: "browserTelemetry", Label: "Browser telemetry (Faro)",
			Hint: "Instrument your frontend with @nais/apm (Faro) to get web vitals, errors and sessions."},
		{Key: "alertRules", Label: "Alert rules",
			Hint: "No alert rule mentions this service — start with 'Alert on error rate' in the service actions menu."},
	}

	var wg sync.WaitGroup
	wg.Add(6)
	go func() { defer wg.Done(); checks[0].OK = a.checkSpanMetrics(ctx, namespace, service, env, now) }()
	go func() {
		defer wg.Done()
		checks[1].OK = a.checkTempoTraces(ctx, headers, token, namespace, service, env, now)
	}()
	go func() { defer wg.Done(); checks[2].OK = a.checkLokiLogs(ctx, headers, token, service, env, now) }()
	go func() { defer wg.Done(); checks[3].OK = a.checkRuntimeMetrics(ctx, namespace, service, env, now) }()
	go func() { defer wg.Done(); checks[4].OK = a.checkBrowserTelemetry(ctx, service, env, now) }()
	go func() { defer wg.Done(); checks[5].OK = a.checkAlertRules(ctx, headers, token, service) }()
	wg.Wait()

	score := 0
	for _, c := range checks {
		if c.OK {
			score++
		}
	}
	return ScorecardReadiness{Score: score, Total: len(checks), Checks: checks}
}

// promSelectorNonEmpty runs count(<selector>) as an instant query and reports
// whether any series matched. Errors degrade to false (check not passed).
func (a *App) promSelectorNonEmpty(ctx context.Context, selector string, at time.Time) bool {
	client := a.prom(ctx)
	if client == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, scorecardProbeTimeout)
	defer cancel()
	results, err := client.InstantQuery(ctx, fmt.Sprintf(`count(%s)`, selector), at)
	if err != nil {
		log.DefaultLogger.Debug("Scorecard prom probe failed", "selector", sanitizeLogValue(selector), "error", err)
		return false
	}
	return len(results) > 0
}

func (a *App) checkSpanMetrics(ctx context.Context, namespace, service, env string, at time.Time) bool {
	filter := a.otelCfg.ServiceFilter(service, namespace)
	if m := envMatcher(a.otelCfg.Labels.DeploymentEnv, env); m != "" {
		filter += ", " + m
	}
	return a.promSelectorNonEmpty(ctx, fmt.Sprintf(`%s{%s}`, a.callsMetric(ctx), filter), at)
}

func (a *App) checkRuntimeMetrics(ctx context.Context, namespace, service, env string, at time.Time) bool {
	// Same metric families as the Runtime tab's discovery query.
	filter := a.otelCfg.RuntimeFilter(service, namespace)
	if m := envMatcher(a.otelCfg.Labels.DeploymentEnv, env); m != "" {
		filter += ", " + m
	}
	return a.promSelectorNonEmpty(ctx, fmt.Sprintf(
		`{%s, __name__=~"jvm_.*|nodejs_.*|hikaricp_.*|db_client_connections_.*|kafka_consumer_.*|kafka_producer_.*|process_.*|system_.*|go_.*"}`,
		filter), at)
}

func (a *App) checkBrowserTelemetry(ctx context.Context, service, env string, at time.Time) bool {
	// Presence of any Alloy-generated Faro metric for this app — mirrors the
	// Frontend tab's histogram detection but as a single cheap probe.
	return a.promSelectorNonEmpty(ctx, fmt.Sprintf(
		`{%s, __name__=~".*faro_.*"}`, a.otelCfg.AlloyHistogramFilter(service, env)), at)
}

// checkTempoTraces asks Tempo's search API (through the datasource proxy) for
// one trace from the service in the recent window.
func (a *App) checkTempoTraces(ctx context.Context, headers http.Header, token, namespace, service, env string, at time.Time) bool {
	base := a.tempoURL(env)
	if base == "" {
		return false
	}
	traceql := fmt.Sprintf(`{%s="%s"}`, a.otelCfg.TraceQL.ServiceName, service)
	if namespace != "" {
		traceql = fmt.Sprintf(`{%s="%s" && %s="%s"}`,
			a.otelCfg.TraceQL.ServiceName, service, a.otelCfg.TraceQL.ServiceNamespace, namespace)
	}
	q := url.Values{
		"q":     {traceql},
		"limit": {"1"},
		"start": {fmt.Sprintf("%d", at.Add(-scorecardTraceLookback).Unix())},
		"end":   {fmt.Sprintf("%d", at.Unix())},
	}

	body, err := a.proxyGET(ctx, headers, token, base+"/api/search?"+q.Encode())
	if err != nil {
		log.DefaultLogger.Debug("Scorecard tempo probe failed", "error", err)
		return false
	}
	var parsed struct {
		Traces []json.RawMessage `json:"traces"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return false
	}
	return len(parsed.Traces) > 0
}

// checkLokiLogs asks Loki's index/stats API (cheap: index-only, no chunks)
// whether any streams exist for the service in the recent window.
func (a *App) checkLokiLogs(ctx context.Context, headers http.Header, token, service, env string, at time.Time) bool {
	base := a.lokiURL(env)
	if base == "" {
		return false
	}
	q := url.Values{
		"query": {fmt.Sprintf(`{%s="%s"}`, a.otelCfg.FaroLoki.ServiceName, service)},
		"start": {fmt.Sprintf("%d", at.Add(-scorecardTraceLookback).Unix())},
		"end":   {fmt.Sprintf("%d", at.Unix())},
	}

	body, err := a.proxyGET(ctx, headers, token, base+"/loki/api/v1/index/stats?"+q.Encode())
	if err != nil {
		log.DefaultLogger.Debug("Scorecard loki probe failed", "error", err)
		return false
	}
	var parsed struct {
		Streams int64 `json:"streams"`
		Entries int64 `json:"entries"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return false
	}
	return parsed.Streams > 0 || parsed.Entries > 0
}

// checkAlertRules scans Mimir ruler rules and Grafana-managed rules for any
// alerting rule that mentions the service, capped at maxScorecardRuleScan.
func (a *App) checkAlertRules(ctx context.Context, headers http.Header, token, service string) bool {
	ctx, cancel := context.WithTimeout(ctx, scorecardProbeTimeout)
	defer cancel()

	var (
		wg      sync.WaitGroup
		sources [2]*queries.RulesResponse
	)
	if prom := a.prom(ctx); prom != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rules, err := prom.GetAlertRules(ctx)
			if err != nil {
				log.DefaultLogger.Debug("Scorecard mimir rules probe failed", "error", err)
				return
			}
			sources[0] = rules
		}()
	}
	if a.grafanaURL != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			client := queries.NewPrometheusClient(a.grafanaURL+"/api/prometheus/grafana", token).WithAuthHeaders(headers)
			rules, err := client.GetAlertRules(ctx)
			if err != nil {
				log.DefaultLogger.Debug("Scorecard grafana rules probe failed", "error", err)
				return
			}
			sources[1] = rules
		}()
	}
	wg.Wait()

	scanned := 0
	for _, src := range sources {
		if src == nil {
			continue
		}
		for _, group := range src.Groups {
			for _, rule := range group.Rules {
				if scanned >= maxScorecardRuleScan {
					return false
				}
				scanned++
				if rule.Type != "alerting" {
					continue
				}
				if ruleMentionsService(rule, service) {
					return true
				}
			}
		}
	}
	return false
}

// ruleMentionsService reports whether an alerting rule targets the service.
// Matching is deliberately conservative (quoted occurrences in the query
// expression, or exact label values) — short service names like "api" would
// otherwise substring-match half the fleet's rules.
func ruleMentionsService(rule queries.Rule, service string) bool {
	if service == "" {
		return false
	}
	// PromQL expressions: service_name="svc"; Grafana-managed rules expose the
	// JSON-encoded query data where quotes are escaped: \"svc\".
	if strings.Contains(rule.Query, `"`+service+`"`) || strings.Contains(rule.Query, `\"`+service+`\"`) {
		return true
	}
	for _, key := range []string{"service", "service_name", "app", "app_name", "deployment"} {
		if rule.Labels[key] == service {
			return true
		}
	}
	return false
}

// proxyGET performs an authenticated GET through the Grafana datasource proxy
// and returns the body on 2xx.
func (a *App) proxyGET(ctx context.Context, headers http.Header, token, reqURL string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, scorecardProbeTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	applyProxyAuth(req, headers, token)

	resp, err := a.healthClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close() //nolint:errcheck
	}()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 10<<20))
}

// ---------------------------------------------------------------------------
// nais Console enrichment
// ---------------------------------------------------------------------------

// scorecardTeamQuery fetches team ownership facts. Shaped like naissync.go's
// queries; the nais schema exposes team(slug: Slug!) with slackChannel.
const scorecardTeamQuery = `query($slug: Slug!) {
  team(slug: $slug) { slug slackChannel }
}`

// scorecardAppsQuery lists the team's applications with ingress URLs; the
// service's ingresses are picked out client-side (no by-name filter arg is
// assumed, keeping the query on the widely-deployed schema surface).
const scorecardAppsQuery = `query($slug: Slug!, $first: Int!) {
  team(slug: $slug) {
    applications(first: $first) {
      nodes { name ingresses { url } }
    }
  }
}`

// fetchConsoleEnrichment queries the nais Console GraphQL API for ownership
// facts. Each fact uses its own query so a schema lacking one field degrades
// per-field: the failing query is logged and its fields omitted.
func (a *App) fetchConsoleEnrichment(ctx context.Context, namespace, service string) ScorecardConsole {
	if a.settings.NaisAPIURL == "" || a.naisToken == "" {
		return ScorecardConsole{Configured: false}
	}
	out := ScorecardConsole{Configured: true}
	if namespace == "" {
		// Without a namespace there is no team to resolve — nais teams own
		// their namespace, so the namespace IS the team slug.
		return out
	}
	logger := log.DefaultLogger.With("handler", "scorecard", "team", namespace)

	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		vars = map[string]any{"slug": namespace}
	)

	// Team slug + slack channel.
	wg.Add(1)
	go func() {
		defer wg.Done()
		var resp struct {
			Team struct {
				Slug         string `json:"slug"`
				SlackChannel string `json:"slackChannel"`
			} `json:"team"`
		}
		if err := a.naisGraphQL(ctx, scorecardTeamQuery, vars, &resp); err != nil {
			logger.Debug("Console team query degraded", "error", err)
			return
		}
		mu.Lock()
		out.TeamSlug = resp.Team.Slug
		out.SlackChannel = resp.Team.SlackChannel
		mu.Unlock()
	}()

	// Ingress URLs for this application.
	wg.Add(1)
	go func() {
		defer wg.Done()
		var resp struct {
			Team struct {
				Applications struct {
					Nodes []struct {
						Name      string `json:"name"`
						Ingresses []struct {
							URL string `json:"url"`
						} `json:"ingresses"`
					} `json:"nodes"`
				} `json:"applications"`
			} `json:"team"`
		}
		appsVars := map[string]any{"slug": namespace, "first": scorecardConsoleAppsPageSize}
		if err := a.naisGraphQL(ctx, scorecardAppsQuery, appsVars, &resp); err != nil {
			logger.Debug("Console applications query degraded", "error", err)
			return
		}
		var ingresses []string
		for _, node := range resp.Team.Applications.Nodes {
			if node.Name != service {
				continue
			}
			for _, ing := range node.Ingresses {
				if ing.URL != "" && len(ingresses) < maxScorecardIngresses {
					ingresses = append(ingresses, ing.URL)
				}
			}
			break
		}
		mu.Lock()
		out.Ingresses = ingresses
		mu.Unlock()
	}()

	// Repository URL, derived from the latest deployment's trigger URL —
	// reuses the deployments query naissync.go already exercises against the
	// deployed schema, so it survives Application-type schema drift.
	wg.Add(1)
	go func() {
		defer wg.Done()
		deployments, err := a.fetchNaisDeployments(ctx, a.naisToken)
		if err != nil {
			logger.Debug("Console deployments query degraded", "error", err)
			return
		}
		for _, d := range deployments {
			if d.TeamSlug != namespace {
				continue
			}
			match := false
			for _, r := range d.Resources {
				if (r.Kind == "Application" || r.Kind == "Job" || r.Kind == "Naisjob") && r.Name == service {
					match = true
					break
				}
			}
			if !match {
				continue
			}
			if repo := deriveRepoURL(d.TriggerURL); repo != "" {
				mu.Lock()
				out.RepositoryURL = repo
				mu.Unlock()
				return
			}
		}
	}()

	wg.Wait()
	return out
}

// deriveRepoURL extracts the repository URL from a GitHub Actions trigger URL
// (https://github.com/{owner}/{repo}/actions/runs/N → https://github.com/{owner}/{repo}).
// Returns "" for anything that doesn't look like one.
func deriveRepoURL(triggerURL string) string {
	if !strings.HasPrefix(triggerURL, "https://") {
		return ""
	}
	idx := strings.Index(triggerURL, "/actions/")
	if idx <= 0 {
		return ""
	}
	repo := triggerURL[:idx]
	// Expect scheme://host/owner/repo — 5 slash-separated parts.
	if parts := strings.Split(repo, "/"); len(parts) != 5 || parts[3] == "" || parts[4] == "" {
		return ""
	}
	return repo
}

// naisGraphQL posts one GraphQL query to the nais Console API and unmarshals
// the data envelope into out. Auth and shape mirror fetchNaisDeployments.
func (a *App) naisGraphQL(ctx context.Context, query string, vars map[string]any, out any) error {
	body, err := json.Marshal(map[string]any{"query": query, "variables": vars})
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, scorecardProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.settings.NaisAPIURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.naisToken)

	resp, err := a.healthClient.Do(req)
	if err != nil {
		return fmt.Errorf("querying nais API: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("nais API returned %d: %s", resp.StatusCode, truncateStr(string(raw)))
	}

	var envelope struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("unmarshaling nais response: %w", err)
	}
	if len(envelope.Errors) > 0 {
		return fmt.Errorf("nais API error: %s", envelope.Errors[0].Message)
	}
	if len(envelope.Data) == 0 {
		return fmt.Errorf("nais API returned no data")
	}
	return json.Unmarshal(envelope.Data, out)
}
