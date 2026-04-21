package plugin

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// handleFrontendMetrics returns browser/Faro metric availability and latest values for a service.
func (a *App) handleFrontendMetrics(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	namespace := queries.MustSanitizeLabel(req.PathValue("namespace"))
	service := queries.MustSanitizeLabel(req.PathValue("service"))
	env := req.URL.Query().Get("environment")

	if !requireServiceParam(w, service) {
		return
	}

	now := time.Now()
	result := a.queryFrontendMetrics(ctx, namespace, service, env, now, req.Header)
	writeJSON(w, result)
}

// FrontendMetricsResponse contains browser/Faro metrics for a service.
type FrontendMetricsResponse struct {
	Available bool               `json:"available"`
	Source    string             `json:"source,omitempty"` // "mimir" or "loki"
	Vitals    map[string]float64 `json:"vitals,omitempty"`
	ErrorRate float64            `json:"errorRate"`
}

func (a *App) queryFrontendMetrics(ctx context.Context, namespace, service, env string, at time.Time, headers http.Header) FrontendMetricsResponse {
	// 1. Try Mimir first
	if a.promClient != nil {
		resp := a.queryFrontendFromMimir(ctx, namespace, service, at)
		if resp.Available {
			return resp
		}
	}

	// 2. Fall back to Loki (Faro structured logs)
	lokiResp := a.queryFrontendFromLoki(ctx, service, env, at, headers)
	if lokiResp.Available {
		return lokiResp
	}

	return FrontendMetricsResponse{Available: false}
}

// queryFrontendFromMimir checks Prometheus/Mimir for browser metrics.
func (a *App) queryFrontendFromMimir(ctx context.Context, namespace, service string, at time.Time) FrontendMetricsResponse {
	filter := a.otelCfg.ServiceFilter(service, namespace)

	checkQ := fmt.Sprintf(`count(%s{%s})`, a.otelCfg.BrowserMetrics.LCP, filter)
	results, err := a.prom(ctx).InstantQuery(ctx, checkQ, at)
	if err != nil || len(results) == 0 || results[0].Value.Float() == 0 {
		return FrontendMetricsResponse{Available: false}
	}

	resp := FrontendMetricsResponse{
		Available: true,
		Source:    "mimir",
		Vitals:    make(map[string]float64),
	}

	vitalMetrics := map[string]string{
		"lcp":  a.otelCfg.BrowserMetrics.LCP,
		"fcp":  a.otelCfg.BrowserMetrics.FCP,
		"cls":  a.otelCfg.BrowserMetrics.CLS,
		"inp":  a.otelCfg.BrowserMetrics.INP,
		"ttfb": a.otelCfg.BrowserMetrics.TTFB,
	}

	// Query all vitals + error rate in parallel
	var wg sync.WaitGroup
	var mu sync.Mutex

	for key, metric := range vitalMetrics {
		wg.Add(1)
		go func(k, m string) {
			defer wg.Done()
			q := fmt.Sprintf(`avg(%s{%s})`, m, filter)
			r, err := a.prom(ctx).InstantQuery(ctx, q, at)
			if err == nil && len(r) > 0 {
				mu.Lock()
				resp.Vitals[k] = roundTo(r[0].Value.Float(), 2)
				mu.Unlock()
			}
		}(key, metric)
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		errQ := fmt.Sprintf(`sum(rate(%s{%s}[5m]))`, a.otelCfg.BrowserMetrics.Errors, filter)
		r, err := a.prom(ctx).InstantQuery(ctx, errQ, at)
		if err == nil && len(r) > 0 {
			mu.Lock()
			resp.ErrorRate = roundTo(r[0].Value.Float(), 4)
			mu.Unlock()
		}
	}()

	wg.Wait()

	return resp
}

// queryFrontendFromLoki checks Loki for Faro measurement logs.
func (a *App) queryFrontendFromLoki(ctx context.Context, service, env string, at time.Time, headers http.Header) FrontendMetricsResponse {
	lokiURL := a.lokiURL(env)
	if lokiURL == "" {
		return FrontendMetricsResponse{Available: false}
	}

	lokiClient := queries.NewLokiMetricClient(lokiURL, a.serviceToken)
	if headers != nil {
		lokiClient = lokiClient.WithAuthHeaders(headers)
	}

	// Existence check: are there any measurement logs in the last hour?
	checkQ := fmt.Sprintf(
		`count_over_time(%s [1h])`,
		a.otelCfg.LokiStreamSelector(service, a.otelCfg.FaroLoki.KindMeasurement),
	)
	results, err := lokiClient.InstantQuery(ctx, checkQ, at)
	if err != nil || len(results) == 0 {
		return FrontendMetricsResponse{Available: false}
	}

	// Sum all streams to get total count
	total := 0.0
	for _, r := range results {
		total += r.Value.Float()
	}
	if total == 0 {
		return FrontendMetricsResponse{Available: false}
	}

	// Return availability — let Scenes panels handle the actual queries
	return FrontendMetricsResponse{
		Available: true,
		Source:    "loki",
	}
}
