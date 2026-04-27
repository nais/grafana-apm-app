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

	now := time.Now()
	result := a.queryFrontendMetrics(ctx, namespace, service, env, now, req.Header)
	writeJSON(w, result)
}

// FrontendMetricsResponse → models.go

func (a *App) queryFrontendMetrics(ctx context.Context, namespace, service, env string, at time.Time, headers http.Header) FrontendMetricsResponse {
	// 1. Try Mimir first (standard Faro SDK metrics)
	if a.promClient != nil {
		resp := a.queryFrontendFromMimir(ctx, namespace, service, env, at)
		if resp.Available {
			return resp
		}
	}

	// 2. Try Alloy histograms (proper percentile-capable metrics) + Loki for enrichment
	if a.promClient != nil {
		histResp := a.queryFrontendFromAlloyHistogram(ctx, service, env, at)
		if histResp.Available {
			// Check if Loki also has data for hybrid rendering
			histResp.HasLoki = a.hasLokiFaroData(ctx, service, env, at, headers)
			return histResp
		}
	}

	// 3. Try Loki (Faro structured logs — proper weighted mean across all measurements)
	lokiResp := a.queryFrontendFromLoki(ctx, service, env, at, headers)
	if lokiResp.Available {
		return lokiResp
	}

	// 4. Fall back to Alloy Faro pipeline gauge metrics (last-writer-wins).
	// Only used when no better source is available.
	if a.promClient != nil {
		resp := a.queryFrontendFromAlloy(ctx, service, env, at)
		if resp.Available {
			// Check if Loki also has data for hybrid rendering
			resp.HasLoki = a.hasLokiFaroData(ctx, service, env, at, headers)
			return resp
		}
	}

	return FrontendMetricsResponse{Available: false}
}

// queryFrontendFromMimir checks Prometheus/Mimir for browser metrics.
func (a *App) queryFrontendFromMimir(ctx context.Context, namespace, service, environment string, at time.Time) FrontendMetricsResponse {
	filter := a.otelCfg.ServiceFilter(service, namespace)
	if environment != "" {
		filter += fmt.Sprintf(`, %s="%s"`, a.otelCfg.Labels.DeploymentEnv, environment)
	}

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
			if err == nil && len(r) > 0 && isValidMetricValue(r[0].Value.Float()) {
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
		if err == nil && len(r) > 0 && isValidMetricValue(r[0].Value.Float()) {
			mu.Lock()
			resp.ErrorRate = roundTo(r[0].Value.Float(), 4)
			mu.Unlock()
		}
	}()

	wg.Wait()

	return resp
}

// queryFrontendFromAlloy checks Prometheus/Mimir for Alloy Faro pipeline metrics.
// These use "loki_process_custom_" prefix and "app_name" label instead of "service_name".
// Samples are sparse (5–15 min intervals), so we use last_over_time with a wide lookback.
func (a *App) queryFrontendFromAlloy(ctx context.Context, service, environment string, at time.Time) FrontendMetricsResponse {
	alloy := a.otelCfg.AlloyBrowserMetrics
	filter := a.otelCfg.AlloyFilter(service, environment)
	lookback := alloy.Lookback

	// Detection: check if any LCP data exists within the lookback window
	checkQ := fmt.Sprintf(`count(last_over_time(%s{%s}[%s]))`, alloy.LCP, filter, lookback)
	results, err := a.prom(ctx).InstantQuery(ctx, checkQ, at)
	if err != nil || len(results) == 0 || results[0].Value.Float() == 0 {
		return FrontendMetricsResponse{Available: false}
	}

	resp := FrontendMetricsResponse{
		Available: true,
		Source:    "alloy",
		Vitals:    make(map[string]float64),
	}

	vitalMetrics := map[string]string{
		"lcp":  alloy.LCP,
		"fcp":  alloy.FCP,
		"cls":  alloy.CLS,
		"inp":  alloy.INP,
		"ttfb": alloy.TTFB,
	}

	var wg sync.WaitGroup
	var mu sync.Mutex

	// Use avg_over_time to average across available gauge samples.
	// Note: these gauges are last-writer-wins, so each sample is a single
	// user's measurement. The average is over ~10 samples/hr, not thousands.
	for key, metric := range vitalMetrics {
		wg.Add(1)
		go func(k, m string) {
			defer wg.Done()
			q := fmt.Sprintf(`avg(avg_over_time(%s{%s}[%s]))`, m, filter, lookback)
			r, err := a.prom(ctx).InstantQuery(ctx, q, at)
			if err == nil && len(r) > 0 && isValidMetricValue(r[0].Value.Float()) {
				mu.Lock()
				resp.Vitals[k] = roundTo(r[0].Value.Float(), 2)
				mu.Unlock()
			}
		}(key, metric)
	}

	// Error rate: use increase over a wider window due to sparse samples
	wg.Add(1)
	go func() {
		defer wg.Done()
		errQ := fmt.Sprintf(`sum(increase(%s{%s}[%s])) / %d`, alloy.Errors, filter, lookback, 1800)
		r, err := a.prom(ctx).InstantQuery(ctx, errQ, at)
		if err == nil && len(r) > 0 && isValidMetricValue(r[0].Value.Float()) {
			mu.Lock()
			resp.ErrorRate = roundTo(r[0].Value.Float(), 4)
			mu.Unlock()
		}
	}()

	wg.Wait()

	return resp
}

// queryFrontendFromAlloyHistogram checks for histogram-based Alloy Faro metrics.
// These provide proper percentile computation via histogram_quantile.
func (a *App) queryFrontendFromAlloyHistogram(ctx context.Context, service, environment string, at time.Time) FrontendMetricsResponse {
	h := a.otelCfg.AlloyHistogramMetrics
	filter := a.otelCfg.AlloyHistogramFilter(service, environment)

	// Detection: check if LCP histogram buckets exist
	checkQ := fmt.Sprintf(`count(%s_bucket{%s, le="+Inf"})`, h.LCP, filter)
	results, err := a.prom(ctx).InstantQuery(ctx, checkQ, at)
	if err != nil || len(results) == 0 || results[0].Value.Float() == 0 {
		return FrontendMetricsResponse{Available: false}
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

	// Compute p75 for each vital using histogram_quantile
	for key, metric := range vitalMetrics {
		wg.Add(1)
		go func(k, m string) {
			defer wg.Done()
			q := fmt.Sprintf(`histogram_quantile(0.75, sum(rate(%s_bucket{%s}[5m])) by (le))`, m, filter)
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
		errQ := fmt.Sprintf(`sum(rate(%s{%s}[5m]))`, h.Errors, filter)
		r, err := a.prom(ctx).InstantQuery(ctx, errQ, at)
		if err == nil && len(r) > 0 && isValidMetricValue(r[0].Value.Float()) {
			mu.Lock()
			resp.ErrorRate = roundTo(r[0].Value.Float(), 4)
			mu.Unlock()
		}
	}()

	wg.Wait()

	// If all vitals are NaN (e.g., no new measurements in the rate window),
	// treat as unavailable so we fall through to Loki.
	if len(resp.Vitals) == 0 {
		return FrontendMetricsResponse{Available: false}
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
		`count_over_time(%s [1h])`,
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
