package plugin

import (
	"net/http"
	"sort"
	"strings"
	"sync"

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
	namespace, service := parseServiceRef(req)
	if !requireServiceParam(w, service) {
		return
	}

	// Rules aren't time- or environment-scoped in this fetch, so the cache key
	// is just org + service (namespace disambiguates same-named services).
	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("service-alerts", orgID, namespace, service)
	a.writeCached(w, ck, "querying service alerts failed", func() (any, error) {
		return a.computeServiceAlerts(req, service), nil
	})
}

// computeServiceAlerts fans out to both rule sources (like handleNamespaceAlerts)
// and filters to rules mentioning the service, degrading per-source.
func (a *App) computeServiceAlerts(req *http.Request, service string) ServiceAlertsResponse {
	logger := log.DefaultLogger.With("handler", "service-alerts")

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
		// degrade to Mimir-only rather than failing the tab.
		logger.Debug("Failed to fetch Grafana-managed alert rules", "error", grafanaErr)
	}

	// Neither source configured → empty (not an error; the local/dev case).
	if prom == nil && grafanaRules == nil {
		return ServiceAlertsResponse{Rules: []AlertRuleSummary{}}
	}
	// Both sources configured but both failed → surface the unavailable state.
	if mimirRules == nil && grafanaResp == nil {
		return ServiceAlertsResponse{
			Rules:        []AlertRuleSummary{},
			Unavailable:  true,
			ErrorMessage: "Unable to fetch alert rules",
		}
	}

	var filtered []AlertRuleSummary
	filtered = append(filtered, summarizeServiceAlertRules(mimirRules, service, alertSourceMimir)...)
	filtered = append(filtered, summarizeServiceAlertRules(grafanaResp, service, alertSourceGrafana)...)

	return ServiceAlertsResponse{Rules: dedupeAndSortAlertRules(filtered)}
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
					// Mimir ruler group file path: "{cluster}/{namespace}/{rule}/{uuid}"
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
// In NAIS, ruler groups are stored as "{cluster}/{namespace}/{rulename}/{uuid}",
// e.g. "dev-fss/teamfrikort/frikort-alerts/869209f5-...".
// The namespace is the second path segment.
func extractNamespaceFromGroupFile(file string) string {
	parts := strings.SplitN(file, "/", 3)
	if len(parts) >= 2 && parts[1] != "" {
		return parts[1]
	}
	return ""
}
