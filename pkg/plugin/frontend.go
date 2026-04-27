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
	namespace, service := parseServiceRef(req)
	env := parseEnvironment(req)

	if !requireServiceParam(w, service) {
		return
	}

	// Cache key: frontend metrics are expensive (multiple datasource probes)
	ck := cacheKey("frontend", namespace, service, env)
	if cached, ok := a.respCache.get(ck); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Cache", "HIT")
		_, _ = w.Write(cached)
		return
	}

	now := time.Now()
	result := a.queryFrontendMetrics(ctx, service, env, now, req.Header)

	a.respCache.setJSON(ck, result)
	writeJSON(w, result)
}

// FrontendMetricsResponse → models.go

func (a *App) queryFrontendMetrics(ctx context.Context, service, env string, at time.Time, headers http.Header) FrontendMetricsResponse {
	// 1. Try Alloy histograms (proper percentile-capable metrics) + Loki for enrichment
	if a.promClient != nil {
		histResp := a.queryFrontendFromAlloyHistogram(ctx, service, env, at)
		if histResp.Available {
			histResp.HasLoki = a.hasLokiFaroData(ctx, service, env, at, headers)
			return histResp
		}
	}

	// 2. Fall back to Loki (structured logs from grafana-agent or alloy-faro)
	lokiResp := a.queryFrontendFromLoki(ctx, service, env, at, headers)
	if lokiResp.Available {
		return lokiResp
	}

	return FrontendMetricsResponse{Available: false}
}

// queryFrontendFromAlloyHistogram checks for histogram-based Alloy Faro metrics.
// These provide proper percentile computation via histogram_quantile.
func (a *App) queryFrontendFromAlloyHistogram(ctx context.Context, service, environment string, at time.Time) FrontendMetricsResponse {
	h := a.otelCfg.AlloyHistogramMetrics
	filter := a.otelCfg.AlloyHistogramFilter(service, environment)

	// Detection: check that any histogram data exists (at least 1 observation in the last 6 hours).
	// Use a wide window so apps with sparse traffic (e.g., dev environments) still show
	// their dashboard. The unified frontend view handles partial data gracefully.
	checkQ := fmt.Sprintf(`sum(increase(%s_bucket{%s, le="+Inf"}[6h]))`, h.LCP, filter)
	results, err := a.prom(ctx).InstantQuery(ctx, checkQ, at)
	hasRecentData := err == nil && len(results) > 0 && isValidMetricValue(results[0].Value.Float()) && results[0].Value.Float() >= 1

	if !hasRecentData {
		// No recent data — check if the metric series exists at all (instrumented but idle).
		existsQ := fmt.Sprintf(`count(%s_bucket{%s})`, h.LCP, filter)
		existsR, existsErr := a.prom(ctx).InstantQuery(ctx, existsQ, at)
		if existsErr != nil || len(existsR) == 0 || existsR[0].Value.Float() == 0 {
			// Metric doesn't exist → not instrumented at all.
			return FrontendMetricsResponse{Available: false}
		}
		// Metric exists but no recent observations → instrumented but idle.
		return FrontendMetricsResponse{
			Available:     true,
			Source:        "alloy-histogram",
			MetricsSource: "alloy-histogram",
		}
	}

	resp := FrontendMetricsResponse{
		Available:     true,
		Source:        "alloy-histogram",
		MetricsSource: "alloy-histogram",
		Vitals:        make(map[string]float64),
	}

	vitalMetrics := map[string]string{
		"lcp":  h.LCP,
		"fcp":  h.FCP,
		"cls":  h.CLS,
		"inp":  h.INP,
		"ttfb": h.TTFB,
	}

	var wg sync.WaitGroup
	var mu sync.Mutex

	// Compute p75 for each vital using histogram_quantile.
	// Use increase over 6h to match the detection window — this ensures bullet charts
	// show meaningful values even for apps with sporadic traffic.
	for key, metric := range vitalMetrics {
		wg.Add(1)
		go func(k, m string) {
			defer wg.Done()
			q := fmt.Sprintf(`histogram_quantile(0.75, sum(increase(%s_bucket{%s}[6h])) by (le))`, m, filter)
			r, err := a.prom(ctx).InstantQuery(ctx, q, at)
			if err == nil && len(r) > 0 && isValidMetricValue(r[0].Value.Float()) {
				mu.Lock()
				resp.Vitals[k] = roundTo(r[0].Value.Float(), 2)
				mu.Unlock()
			}
		}(key, metric)
	}

	// Error rate from counter
	wg.Add(1)
	go func() {
		defer wg.Done()
		errQ := fmt.Sprintf(`sum(rate(%s{%s}[6h]))`, h.Errors, filter)
		r, err := a.prom(ctx).InstantQuery(ctx, errQ, at)
		if err == nil && len(r) > 0 && isValidMetricValue(r[0].Value.Float()) {
			mu.Lock()
			resp.ErrorRate = roundTo(r[0].Value.Float(), 4)
			mu.Unlock()
		}
	}()

	wg.Wait()

	// If all vitals are NaN (e.g., sparse data in the window), return as instrumented
	// but with no vitals — the frontend will show the dashboard with empty panels.
	if len(resp.Vitals) == 0 {
		resp.Vitals = nil
	}

	return resp
}

// hasLokiFaroData performs a lightweight check for Loki Faro measurement logs.
func (a *App) hasLokiFaroData(ctx context.Context, service, env string, at time.Time, headers http.Header) bool {
	lokiURL := a.lokiURL(env)
	if lokiURL == "" {
		return false
	}

	lokiClient := queries.NewLokiMetricClient(lokiURL, a.resolveServiceToken(ctx))
	if headers != nil {
		lokiClient = lokiClient.WithAuthHeaders(headers)
	}

	checkQ := fmt.Sprintf(
		`count_over_time(%s [6h])`,
		a.otelCfg.LokiStreamSelector(service, a.otelCfg.FaroLoki.KindMeasurement),
	)
	results, err := lokiClient.InstantQuery(ctx, checkQ, at)
	if err != nil || len(results) == 0 {
		return false
	}

	total := 0.0
	for _, r := range results {
		total += r.Value.Float()
	}
	return total > 0
}

// queryFrontendFromLoki checks Loki for Faro measurement logs.
func (a *App) queryFrontendFromLoki(ctx context.Context, service, env string, at time.Time, headers http.Header) FrontendMetricsResponse {
	lokiURL := a.lokiURL(env)
	if lokiURL == "" {
		return FrontendMetricsResponse{Available: false}
	}

	lokiClient := queries.NewLokiMetricClient(lokiURL, a.resolveServiceToken(ctx))
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

	resp := FrontendMetricsResponse{
		Available: true,
		Source:    "loki",
		Vitals:    make(map[string]float64),
	}

	// Query vital values in parallel
	vitalFields := map[string]string{
		"lcp":  a.otelCfg.FaroLoki.LCP,
		"fcp":  a.otelCfg.FaroLoki.FCP,
		"cls":  a.otelCfg.FaroLoki.CLS,
		"inp":  a.otelCfg.FaroLoki.INP,
		"ttfb": a.otelCfg.FaroLoki.TTFB,
	}

	var wg sync.WaitGroup
	var mu sync.Mutex

	for key, field := range vitalFields {
		wg.Add(1)
		go func(k, f string) {
			defer wg.Done()
			q := a.otelCfg.LokiVitalQuery(service, f, "[1h]")
			r, err := lokiClient.InstantQuery(ctx, q, at)
			if err == nil && len(r) > 0 && r[0].Value.Float() > 0 {
				mu.Lock()
				resp.Vitals[k] = roundTo(r[0].Value.Float(), 2)
				mu.Unlock()
			}
		}(key, field)
	}

	wg.Wait()

	return resp
}
