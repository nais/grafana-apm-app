package plugin

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// handleFrontendMetrics returns browser/Faro metric availability and latest values for a service.
func (a *App) handleFrontendMetrics(w http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	namespace := queries.MustSanitizeLabel(req.PathValue("namespace"))
	service := queries.MustSanitizeLabel(req.PathValue("service"))

	if service == "" {
		http.Error(w, `{"error":"missing service"}`, http.StatusBadRequest)
		return
	}

	now := time.Now()
	result := a.queryFrontendMetrics(ctx, namespace, service, now)
	writeJSON(w, result)
}

type FrontendMetricsResponse struct {
	Available bool               `json:"available"`
	Vitals    map[string]float64 `json:"vitals,omitempty"`
	ErrorRate float64            `json:"errorRate"`
}

func (a *App) queryFrontendMetrics(ctx context.Context, namespace, service string, at time.Time) FrontendMetricsResponse {
	if a.promClient == nil {
		return FrontendMetricsResponse{}
	}

	filter := fmt.Sprintf(`service_name="%s"`, service)
	if namespace != "" {
		filter += fmt.Sprintf(`, service_namespace="%s"`, namespace)
	}

	// Quick existence check
	checkQ := fmt.Sprintf(`count(browser_web_vitals_lcp_milliseconds{%s})`, filter)
	results, err := a.promClient.InstantQuery(ctx, checkQ, at)
	if err != nil || len(results) == 0 || results[0].Value.Float() == 0 {
		return FrontendMetricsResponse{Available: false}
	}

	resp := FrontendMetricsResponse{
		Available: true,
		Vitals:    make(map[string]float64),
	}

	// Fetch latest average values for each vital
	vitalMetrics := map[string]string{
		"lcp":  "browser_web_vitals_lcp_milliseconds",
		"fcp":  "browser_web_vitals_fcp_milliseconds",
		"cls":  "browser_web_vitals_cls",
		"inp":  "browser_web_vitals_inp_milliseconds",
		"ttfb": "browser_web_vitals_ttfb_milliseconds",
	}

	for key, metric := range vitalMetrics {
		q := fmt.Sprintf(`avg(%s{%s})`, metric, filter)
		r, err := a.promClient.InstantQuery(ctx, q, at)
		if err == nil && len(r) > 0 {
			resp.Vitals[key] = roundTo(r[0].Value.Float(), 2)
		}
	}

	// Error rate
	errQ := fmt.Sprintf(`sum(rate(browser_errors_total{%s}[5m]))`, filter)
	r, err := a.promClient.InstantQuery(ctx, errQ, at)
	if err == nil && len(r) > 0 {
		resp.ErrorRate = roundTo(r[0].Value.Float(), 4)
	}

	return resp
}
