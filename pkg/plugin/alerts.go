package plugin

import (
	"net/http"
	"sort"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// handleNamespaceAlerts returns alert rules for a namespace.
// GET /namespaces/{namespace}/alerts
func (a *App) handleNamespaceAlerts(w http.ResponseWriter, req *http.Request) {
	logger := log.DefaultLogger.With("handler", "namespace-alerts")
	namespace := req.PathValue("namespace")
	if namespace == "" {
		http.Error(w, "namespace required", http.StatusBadRequest)
		return
	}

	prom := a.promClientForRequest(req)
	if prom == nil {
		writeJSON(w, NamespaceAlertsResponse{Rules: []AlertRuleSummary{}})
		return
	}

	rules, err := prom.GetAlertRules(req.Context())
	if err != nil {
		logger.Warn("Failed to fetch alert rules", "error", err)
		writeJSON(w, NamespaceAlertsResponse{
			Rules:        []AlertRuleSummary{},
			Unavailable:  true,
			ErrorMessage: "Unable to fetch alert rules",
		})
		return
	}

	// Filter rules by namespace label (exact match on namespace or kubernetes_namespace)
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
			// Also check if the ruler group file/namespace matches
			if ruleNs == "" {
				ruleNs = extractNamespaceFromGroupFile(group.File)
			}

			if !strings.EqualFold(ruleNs, namespace) {
				continue
			}

			// Find earliest activeAt among firing/pending instances
			var activeAt string
			var activeCount int
			for _, alert := range rule.Alerts {
				if alert.State == "firing" || alert.State == "pending" {
					activeCount++
					if activeAt == "" || alert.ActiveAt < activeAt {
						activeAt = alert.ActiveAt
					}
				}
			}

			filtered = append(filtered, AlertRuleSummary{
				Name:        rule.Name,
				State:       rule.State,
				Severity:    rule.Labels["severity"],
				Summary:     rule.Annotations["summary"],
				Description: rule.Annotations["description"],
				ActiveSince: activeAt,
				ActiveCount: activeCount,
				GroupName:   group.Name,
			})
		}
	}

	// Sort: firing first, then pending, then inactive; within each group by name
	stateOrder := map[string]int{"firing": 0, "pending": 1, "inactive": 2}
	sort.Slice(filtered, func(i, j int) bool {
		oi, oj := stateOrder[filtered[i].State], stateOrder[filtered[j].State]
		if oi != oj {
			return oi < oj
		}
		return filtered[i].Name < filtered[j].Name
	})

	writeJSON(w, NamespaceAlertsResponse{Rules: filtered})
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
