package plugin

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// Alert rule sources surfaced on the namespace page.
const (
	alertSourceMimir   = "mimir"   // Prometheus-style rules from the Mimir ruler
	alertSourceGrafana = "grafana" // Grafana-managed (unified alerting) rules
)

// alertInstanceCap bounds the per-rule active-instance list (#33). A rule with
// a high-cardinality label set (e.g. per-path) can have thousands of firing
// instances; we surface the first handful and set InstancesTruncated for the
// rest so the payload stays small.
const alertInstanceCap = 20

const (
	alertRulesCacheTTL        = 30 * time.Second
	maxAlertRulesCacheEntries = 200
)

// handleNamespaceAlerts returns alert rules for a namespace, merged from the
// Mimir ruler and Grafana-managed alerting (#65 Phase 0: rules created via the
// plugin's alert templates are Grafana-managed and must show up here too).
// GET /namespaces/{namespace}/alerts
func (a *App) handleNamespaceAlerts(w http.ResponseWriter, req *http.Request) {
	logger := log.DefaultLogger.With("handler", "namespace-alerts")
	namespace := req.PathValue("namespace")
	if namespace == "" {
		http.Error(w, "namespace required", http.StatusBadRequest)
		return
	}

	prom := a.promClientForRequest(req)
	grafanaRules := a.grafanaRulesClient(req)

	var (
		wg          sync.WaitGroup
		mimirRules  *queries.RulesResponse
		mimirErr    error
		grafanaResp *queries.RulesResponse
		grafanaErr  error
	)
	if prom != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			mimirRules, mimirErr = prom.GetAlertRules(req.Context())
		}()
	}
	if grafanaRules != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			grafanaResp, grafanaErr = grafanaRules.GetAlertRules(req.Context())
		}()
	}
	wg.Wait()

	if mimirErr != nil {
		logger.Warn("Failed to fetch Mimir alert rules", "error", mimirErr)
	}
	if grafanaErr != nil {
		// Expected on Grafana instances without unified-alerting rules access;
		// degrade to Mimir-only rather than failing the page.
		logger.Debug("Failed to fetch Grafana-managed alert rules", "error", grafanaErr)
	}

	// Both sources unavailable → surface the error state (matches previous behavior).
	if prom == nil && grafanaRules == nil {
		writeJSON(w, NamespaceAlertsResponse{Rules: []AlertRuleSummary{}})
		return
	}
	if mimirRules == nil && grafanaResp == nil {
		writeJSON(w, NamespaceAlertsResponse{
			Rules:        []AlertRuleSummary{},
			Unavailable:  true,
			ErrorMessage: "Unable to fetch alert rules",
		})
		return
	}

	var filtered []AlertRuleSummary
	filtered = append(filtered, summarizeAlertRules(mimirRules, namespace, alertSourceMimir)...)
	filtered = append(filtered, summarizeAlertRules(grafanaResp, namespace, alertSourceGrafana)...)

	writeJSON(w, NamespaceAlertsResponse{Rules: dedupeAndSortAlertRules(filtered)})
}

// grafanaRulesClient returns a client for Grafana's Prometheus-compatible
// rules API (/api/prometheus/grafana/api/v1/rules), which exposes
// Grafana-managed alert rules in the same envelope as the Mimir ruler.
func (a *App) grafanaRulesClient(req *http.Request) *queries.PrometheusClient {
	if a.grafanaURL == "" {
		return nil
	}
	token := a.resolveServiceToken(req.Context())
	client := queries.NewPrometheusClient(a.grafanaURL+"/api/prometheus/grafana", token)
	return client.WithAuthHeaders(req.Header)
}

// handleServiceAlerts returns the alert rules that mention a single service,
// merged from the Mimir ruler and Grafana-managed alerting and filtered with
// the same conservative name matcher the scorecard uses (ruleMentionsService,
// scorecard.go) — no fleet-wide substring hits. This is the service-scoped
// sibling of handleNamespaceAlerts and the payload behind the Alerts tab's
// rule list, now enriched with each rule's read-only firing state and active
// instances (#33); the #32 firing-alert detail drawer builds on this later.
// GET /services/{namespace}/{service}/alerts
func (a *App) handleServiceAlerts(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	_, service := parseServiceRef(req)
	if !requireServiceParam(w, service) {
		return
	}

	writeJSON(w, a.computeServiceAlerts(req, service))
}

// computeServiceAlerts fans out to both rule sources (like handleNamespaceAlerts)
// and filters to rules mentioning the service, degrading per-source.
func (a *App) computeServiceAlerts(req *http.Request, service string) ServiceAlertsResponse {
	ctx := a.requestContext(req)
	sources, err := a.alertRuleSources(ctx, req.Header, a.resolveServiceToken(ctx), parseEnvironment(req))
	if err != nil {
		log.DefaultLogger.Warn("Failed to load alert rule sources", "error", err)
	}
	if err != nil || (sources.Failed && sources.Mimir == nil && sources.Grafana == nil) {
		return ServiceAlertsResponse{
			Rules:        []AlertRuleSummary{},
			Unavailable:  true,
			ErrorMessage: "Unable to fetch alert rules",
		}
	}

	var filtered []AlertRuleSummary
	filtered = append(filtered, summarizeServiceAlertRules(sources.Mimir, service, alertSourceMimir)...)
	filtered = append(filtered, summarizeServiceAlertRules(sources.Grafana, service, alertSourceGrafana)...)

	return ServiceAlertsResponse{Rules: dedupeAndSortAlertRules(filtered), Partial: sources.Failed}
}

type alertRuleSources struct {
	Mimir   *queries.RulesResponse
	Grafana *queries.RulesResponse
	Failed  bool
}

func (a *App) alertRuleSources(ctx context.Context, headers http.Header, token, env string) (alertRuleSources, error) {
	var sources alertRuleSources
	var mimirErr, grafanaErr error
	var wg sync.WaitGroup
	orgID := headers.Get("X-Grafana-Org-Id")
	if prom := a.prom(ctx); prom != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			key := cacheKey("alert-rules", orgID, alertSourceMimir, a.settings.MetricsDataSource.Resolve(env).UID)
			sources.Mimir, mimirErr = a.loadAlertRules(ctx, key, prom.WithAuthHeaders(headers.Clone()))
		}()
	}
	if a.grafanaURL != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			key := cacheKey("alert-rules", orgID, alertSourceGrafana)
			client := queries.NewPrometheusClient(a.grafanaURL+"/api/prometheus/grafana", token).WithAuthHeaders(headers.Clone())
			sources.Grafana, grafanaErr = a.loadAlertRules(ctx, key, client)
		}()
	}
	wg.Wait()
	if mimirErr != nil {
		log.DefaultLogger.Warn("Failed to fetch Mimir alert rules", "error", mimirErr)
	}
	if grafanaErr != nil {
		log.DefaultLogger.Warn("Failed to fetch Grafana-managed alert rules", "error", grafanaErr)
	}
	sources.Failed = mimirErr != nil || grafanaErr != nil
	if sources.Mimir == nil && sources.Grafana == nil {
		return sources, errors.Join(mimirErr, grafanaErr)
	}
	return sources, nil
}

type cachedAlertRules struct {
	rules     *queries.RulesResponse
	fetchedAt time.Time
}

func (a *App) freshAlertRules(key string) (*queries.RulesResponse, bool) {
	a.alertRulesMu.RLock()
	entry, ok := a.alertRulesCache[key]
	a.alertRulesMu.RUnlock()
	return entry.rules, ok && time.Since(entry.fetchedAt) < alertRulesCacheTTL
}

func (a *App) loadAlertRules(ctx context.Context, key string, client *queries.PrometheusClient) (*queries.RulesResponse, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if client.ServiceToken() == "" {
		fetchCtx, cancel := context.WithTimeout(ctx, scorecardProbeTimeout)
		defer cancel()
		return client.GetAlertRules(fetchCtx)
	}
	if rules, ok := a.freshAlertRules(key); ok {
		return rules, nil
	}
	resultCh := a.alertRulesSF.DoChan(key, func() (any, error) {
		if rules, ok := a.freshAlertRules(key); ok {
			return rules, nil
		}
		fetchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), scorecardProbeTimeout)
		defer cancel()
		rules, err := client.GetAlertRules(fetchCtx)
		if err != nil {
			return nil, err
		}
		a.alertRulesMu.Lock()
		defer a.alertRulesMu.Unlock()
		if a.alertRulesCache == nil {
			a.alertRulesCache = make(map[string]cachedAlertRules)
		}
		if _, exists := a.alertRulesCache[key]; !exists && len(a.alertRulesCache) >= maxAlertRulesCacheEntries {
			var oldestKey string
			var oldest time.Time
			for key, entry := range a.alertRulesCache {
				if oldest.IsZero() || entry.fetchedAt.Before(oldest) {
					oldestKey, oldest = key, entry.fetchedAt
				}
			}
			delete(a.alertRulesCache, oldestKey)
		}
		a.alertRulesCache[key] = cachedAlertRules{rules: rules, fetchedAt: time.Now()}
		return rules, nil
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-resultCh:
		if result.Err != nil {
			return nil, result.Err
		}
		return result.Val.(*queries.RulesResponse), nil
	}
}

// summarizeAlertRules filters alerting rules to the given namespace and maps
// them to summaries tagged with their source.
func summarizeAlertRules(rules *queries.RulesResponse, namespace, source string) []AlertRuleSummary {
	if rules == nil {
		return nil
	}
	var filtered []AlertRuleSummary
	for _, group := range rules.Groups {
		for _, rule := range group.Rules {
			if rule.Type != "alerting" {
				continue
			}

			ruleNs := rule.Labels["namespace"]
			if ruleNs == "" {
				ruleNs = rule.Labels["kubernetes_namespace"]
			}
			if ruleNs == "" {
				switch source {
				case alertSourceMimir:
					// Mimir ruler group file path: "{cluster}//{namespace}/{rule}/{uuid}"
					ruleNs = extractNamespaceFromGroupFile(group.File)
				case alertSourceGrafana:
					// Grafana-managed rules: File is the folder title; teams
					// commonly use folder-per-team(-namespace).
					ruleNs = group.File
				}
			}

			if !strings.EqualFold(ruleNs, namespace) {
				continue
			}

			filtered = append(filtered, alertRuleSummary(rule, group, source))
		}
	}
	return filtered
}

// summarizeServiceAlertRules filters alerting rules to those that mention the
// service (reusing the scorecard's conservative ruleMentionsService matcher)
// and maps them to summaries tagged with their source — the service-scoped
// analogue of summarizeAlertRules.
func summarizeServiceAlertRules(rules *queries.RulesResponse, service, source string) []AlertRuleSummary {
	if rules == nil {
		return nil
	}
	var filtered []AlertRuleSummary
	for _, group := range rules.Groups {
		for _, rule := range group.Rules {
			if rule.Type != "alerting" {
				continue
			}
			if !ruleMentionsService(rule, service) {
				continue
			}
			filtered = append(filtered, alertRuleSummary(rule, group, source))
		}
	}
	return filtered
}

// alertRuleSummary maps one ruler alerting rule to the summary surfaced on the
// namespace/service pages, deriving the earliest activeAt / active-instance
// count and tagging it with its source.
func alertRuleSummary(rule queries.Rule, group queries.RuleGroup, source string) AlertRuleSummary {
	var activeAt string
	var activeCount int
	var instances []AlertInstance
	truncated := false
	for _, alert := range rule.Alerts {
		if alert.State != "firing" && alert.State != "pending" {
			continue
		}
		activeCount++
		if activeAt == "" || alert.ActiveAt < activeAt {
			activeAt = alert.ActiveAt
		}
		// Keep the per-instance value/labels the summary used to discard (#33),
		// capping the list so a high-cardinality rule can't bloat the payload.
		if len(instances) < alertInstanceCap {
			instances = append(instances, AlertInstance{
				State:    alert.State,
				Value:    alert.Value,
				ActiveAt: alert.ActiveAt,
				Labels:   alert.Labels,
			})
		} else {
			truncated = true
		}
	}

	return AlertRuleSummary{
		Name:               rule.Name,
		State:              rule.State,
		Severity:           rule.Labels["severity"],
		Summary:            rule.Annotations["summary"],
		Description:        rule.Annotations["description"],
		ActiveSince:        activeAt,
		ActiveCount:        activeCount,
		GroupName:          group.Name,
		Source:             source,
		Expression:         rule.Query,
		ForDuration:        rule.Duration,
		RunbookURL:         rule.Annotations["runbook_url"],
		Instances:          instances,
		InstancesTruncated: truncated,
	}
}

// dedupeAndSortAlertRules merges rules with the same name (same rule in
// multiple clusters, or mirrored between the ruler and Grafana) keeping the
// most severe state, and sorts firing → pending → inactive, then by name.
func dedupeAndSortAlertRules(filtered []AlertRuleSummary) []AlertRuleSummary {
	stateOrder := map[string]int{"firing": 0, "pending": 1, "inactive": 2}
	orderOf := func(state string) int {
		if o, ok := stateOrder[state]; ok {
			return o
		}
		return 99 // unknown states get lowest priority
	}
	deduped := make(map[string]*AlertRuleSummary)
	for i := range filtered {
		r := &filtered[i]
		if existing, ok := deduped[r.Name]; ok {
			// Merge: keep most severe state, sum counts, keep earliest activeSince
			if orderOf(r.State) < orderOf(existing.State) {
				existing.State = r.State
			}
			existing.ActiveCount += r.ActiveCount
			if r.ActiveSince != "" && (existing.ActiveSince == "" || r.ActiveSince < existing.ActiveSince) {
				existing.ActiveSince = r.ActiveSince
			}
			// Merge the active instances of the mirrored rule, keeping the cap.
			for _, inst := range r.Instances {
				if len(existing.Instances) < alertInstanceCap {
					existing.Instances = append(existing.Instances, inst)
				} else {
					existing.InstancesTruncated = true
				}
			}
			if r.InstancesTruncated {
				existing.InstancesTruncated = true
			}
			if existing.Severity == "" && r.Severity != "" {
				existing.Severity = r.Severity
			}
			if existing.Summary == "" && r.Summary != "" {
				existing.Summary = r.Summary
			}
			if existing.Description == "" && r.Description != "" {
				existing.Description = r.Description
			}
		} else {
			cp := *r
			deduped[r.Name] = &cp
		}
	}
	merged := make([]AlertRuleSummary, 0, len(deduped))
	for _, r := range deduped {
		merged = append(merged, *r)
	}

	sort.Slice(merged, func(i, j int) bool {
		oi, oj := orderOf(merged[i].State), orderOf(merged[j].State)
		if oi != oj {
			return oi < oj
		}
		return merged[i].Name < merged[j].Name
	})
	return merged
}

// extractNamespaceFromGroupFile extracts namespace from Mimir ruler file path.
// In NAIS, ruler groups are stored as "{cluster}//{namespace}/{rulename}/{uuid}",
// e.g. "dev-fss//teamfrikort/frikort-alerts/869209f5-..." (Alloy's "<cluster>/"
// prefix plus Mimir's own "/"). The namespace is the second non-empty segment.
func extractNamespaceFromGroupFile(file string) string {
	parts := strings.FieldsFunc(file, func(r rune) bool { return r == '/' })
	if len(parts) >= 2 {
		return parts[1]
	}
	return ""
}
