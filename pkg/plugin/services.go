package plugin

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

func (a *App) handleServices(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}

	if a.promClient == nil {
		http.Error(w, "metrics datasource not configured", http.StatusServiceUnavailable)
		return
	}

	ctx := req.Context()
	ctx = withAuthContext(ctx, a.promClientForRequest(req))

	// Parse time range from query params (defaults: last 1h)
	now := time.Now()
	from := parseUnixParam(req, "from", now.Add(-1*time.Hour))
	to := parseUnixParam(req, "to", now)
	step := parseDurationParam(req, "step", 60*time.Second)
	withSeries := req.URL.Query().Get("withSeries") != "false"
	filterNamespace := queries.MustSanitizeLabel(req.URL.Query().Get("namespace"))
	filterEnvironment := queries.MustSanitizeLabel(req.URL.Query().Get("environment"))

	// Get capability info for metric names
	caps := a.cachedOrDetectCapabilities(ctx)

	if !caps.SpanMetrics.Detected {
		writeJSON(w, []queries.ServiceSummary{})
		return
	}

	services := a.fetchServiceSummaries(ctx, caps, from, to, step, withSeries, filterNamespace, filterEnvironment, req.Header)
	writeJSON(w, services)
}

func (a *App) fetchServiceSummaries( //nolint:gocyclo // complex due to parallel metric aggregation
	ctx context.Context,
	caps queries.Capabilities,
	from, to time.Time,
	step time.Duration,
	withSeries bool,
	filterNamespace, filterEnvironment string,
	headers http.Header,
) []queries.ServiceSummary {
	logger := log.DefaultLogger.With("handler", "services")
	callsMetric := caps.SpanMetrics.CallsMetric
	durationUnit := caps.SpanMetrics.DurationUnit
	durationBucket := caps.SpanMetrics.DurationMetric

	rangeStr := "[5m]"

	// Build optional label filters for namespace/environment
	extraFilters := ""
	if filterNamespace != "" {
		extraFilters += fmt.Sprintf(`, %s="%s"`, a.otelCfg.Labels.ServiceNamespace, filterNamespace)
	}
	if filterEnvironment != "" {
		extraFilters += fmt.Sprintf(`, %s="%s"`, a.otelCfg.Labels.DeploymentEnv, filterEnvironment)
	}

	// Queries: rate, error rate, P95 duration (all grouped by service_name, service_namespace, environment)
	envLabel := a.otelCfg.Labels.DeploymentEnv
	rateQuery := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s{%s="%s"%s}%s))`,
		a.otelCfg.Labels.ServiceName, a.otelCfg.Labels.ServiceNamespace, envLabel,
		callsMetric, a.otelCfg.Labels.SpanKind, a.otelCfg.SpanKinds.Server, extraFilters, rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s{%s="%s", %s="%s"%s}%s))`,
		a.otelCfg.Labels.ServiceName, a.otelCfg.Labels.ServiceNamespace, envLabel,
		callsMetric, a.otelCfg.Labels.SpanKind, a.otelCfg.SpanKinds.Server,
		a.otelCfg.Labels.StatusCode, a.otelCfg.StatusCodes.Error, extraFilters, rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s, %s, %s) (rate(%s{%s="%s"%s}%s)))`,
		a.otelCfg.Labels.ServiceName, a.otelCfg.Labels.ServiceNamespace, envLabel, a.otelCfg.Labels.Le,
		durationBucket, a.otelCfg.Labels.SpanKind, a.otelCfg.SpanKinds.Server, extraFilters, rangeStr,
	)
	// SDK language and environment from labels on span metrics
	sdkQuery := fmt.Sprintf(
		`group by (%s, %s, %s, %s) (%s{%s="%s"%s})`,
		a.otelCfg.Labels.ServiceName, a.otelCfg.Labels.ServiceNamespace,
		a.otelCfg.Labels.SDKLanguage, a.otelCfg.Labels.DeploymentEnv,
		callsMetric, a.otelCfg.Labels.SpanKind, a.otelCfg.SpanKinds.Server, extraFilters,
	)

	// Framework detection from app-emitted metrics (uses app/namespace labels).
	// Single query detecting Ktor, Spring Boot, and Node.js via unique metric names.
	fwExtraFilters := ""
	if filterNamespace != "" {
		fwExtraFilters += fmt.Sprintf(`, %s="%s"`, a.otelCfg.Runtime.Labels.Namespace, filterNamespace)
	}
	frameworkQuery := fmt.Sprintf(
		`group by (%s, %s, __name__) ({__name__=~"ktor_http_server_requests_seconds_count|spring_security_filterchains_access_exceptions_after_total|nodejs_version_info", %s!=""%s})`,
		a.otelCfg.Runtime.Labels.App, a.otelCfg.Runtime.Labels.Namespace,
		a.otelCfg.Runtime.Labels.App, fwExtraFilters,
	)

	type queryResult struct {
		name    string
		results []queries.PromResult
		err     error
	}

	// Run instant queries in parallel
	var wg sync.WaitGroup
	ch := make(chan queryResult, 10)

	// Faro frontend detection: query Loki for app_name label values (parallel, ~100ms)
	var faroApps map[string]bool
	var faroMu sync.Mutex
	lokiURL := a.lokiURL("")
	if lokiURL != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			lokiClient := queries.NewLokiMetricClient(lokiURL)
			if headers != nil {
				lokiClient = lokiClient.WithAuthHeaders(headers)
			}
			apps, err := lokiClient.LabelValues(ctx, a.otelCfg.FaroLoki.AppName)
			if err != nil {
				logger.Warn("Faro label query failed", "error", err)
				return
			}
			faroMu.Lock()
			faroApps = make(map[string]bool, len(apps))
			for _, name := range apps {
				faroApps[name] = true
			}
			faroMu.Unlock()
		}()
	}

	instantQueries := map[string]string{
		"rate":      rateQuery,
		"error":     errorQuery,
		"p95":       p95Query,
		"sdk":       sdkQuery,
		"framework": frameworkQuery,
	}

	for name, q := range instantQueries {
		wg.Add(1)
		go func(n, query string) {
			defer wg.Done()
			results, err := a.prom(ctx).InstantQuery(ctx, query, to)
			ch <- queryResult{name: n, results: results, err: err}
		}(name, q)
	}

	// Optionally run range queries for sparklines
	if withSeries {
		for _, sq := range []struct {
			name  string
			query string
		}{
			{"rateSeries", rateQuery},
			{"durationSeries", p95Query},
		} {
			wg.Add(1)
			go func(n, query string) {
				defer wg.Done()
				results, err := a.prom(ctx).RangeQuery(ctx, query, from, to, step)
				ch <- queryResult{name: n, results: results, err: err}
			}(sq.name, sq.query)
		}
	}

	go func() {
		wg.Wait()
		close(ch)
	}()

	// Collect results
	resultMap := make(map[string][]queries.PromResult)
	for qr := range ch {
		if qr.err != nil {
			logger.Warn("Query failed", "query", qr.name, "error", qr.err)
			continue
		}
		resultMap[qr.name] = qr.results
	}

	// Build service map keyed by "namespace/name/environment"
	type serviceKey struct {
		name        string
		namespace   string
		environment string
	}

	serviceMap := make(map[serviceKey]*queries.ServiceSummary)
	getOrCreate := func(r queries.PromResult) *queries.ServiceSummary {
		k := serviceKey{
			name:        r.Metric[a.otelCfg.Labels.ServiceName],
			namespace:   r.Metric[a.otelCfg.Labels.ServiceNamespace],
			environment: r.Metric[envLabel],
		}
		if s, ok := serviceMap[k]; ok {
			return s
		}
		s := &queries.ServiceSummary{
			Name:         k.name,
			Namespace:    k.namespace,
			Environment:  k.environment,
			DurationUnit: durationUnit,
		}
		serviceMap[k] = s
		return s
	}

	// Fill rate
	for _, r := range resultMap["rate"] {
		s := getOrCreate(r)
		s.Rate = roundTo(r.Value.Float(), 3)
	}

	// Fill error rate as percentage
	for _, r := range resultMap["error"] {
		s := getOrCreate(r)
		if s.Rate > 0 {
			s.ErrorRate = math.Min(roundTo(r.Value.Float()/s.Rate*100, 2), 100)
		}
	}

	// Fill P95 duration
	for _, r := range resultMap["p95"] {
		s := getOrCreate(r)
		v := r.Value.Float()
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			s.P95Duration = roundTo(v, 2)
		}
	}

	// Fill SDK language and environment
	for _, r := range resultMap["sdk"] {
		s := getOrCreate(r)
		if lang, ok := r.Metric[a.otelCfg.Labels.SDKLanguage]; ok && lang != "" && s.SDKLanguage == "" {
			s.SDKLanguage = lang
		}
		if env, ok := r.Metric[a.otelCfg.Labels.DeploymentEnv]; ok && env != "" && s.Environment == "" {
			s.Environment = env
		}
	}

	// Fill framework from app-emitted metrics.
	// Framework results use app/namespace labels — match to service_name/service_namespace.
	// Priority: ktor > spring > nodejs (ktor is more specific than generic Spring/Micrometer).
	type appKey struct {
		name      string
		namespace string
	}
	frameworkMap := make(map[appKey]string)
	for _, r := range resultMap["framework"] {
		app := r.Metric[a.otelCfg.Runtime.Labels.App]
		ns := r.Metric[a.otelCfg.Runtime.Labels.Namespace]
		metricName := r.Metric["__name__"]
		k := appKey{name: app, namespace: ns}
		existing := frameworkMap[k]
		switch metricName {
		case "ktor_http_server_requests_seconds_count":
			frameworkMap[k] = "Ktor"
		case "spring_security_filterchains_access_exceptions_after_total":
			if existing != "Ktor" {
				frameworkMap[k] = "Spring Boot"
			}
		case "nodejs_version_info":
			if existing == "" {
				frameworkMap[k] = "Node.js"
			}
		}
	}
	for _, s := range serviceMap {
		if fw, ok := frameworkMap[appKey{name: s.Name, namespace: s.Namespace}]; ok && s.Framework == "" {
			s.Framework = fw
		}
	}

	// Fill sparkline series
	if withSeries {
		for _, r := range resultMap["rateSeries"] {
			s := getOrCreate(r)
			s.RateSeries = valuesToDataPoints(r.Values)
		}
		for _, r := range resultMap["durationSeries"] {
			s := getOrCreate(r)
			pts := valuesToDataPoints(r.Values)
			// Filter out NaN/Inf from histogram_quantile
			filtered := make([]queries.DataPoint, 0, len(pts))
			for _, p := range pts {
				if !math.IsNaN(p.Value) && !math.IsInf(p.Value, 0) {
					filtered = append(filtered, p)
				}
			}
			s.DurationSeries = filtered
		}
	}

	// Mark services that have Faro frontend data
	faroMu.Lock()
	if faroApps != nil {
		for _, s := range serviceMap {
			if faroApps[s.Name] {
				s.HasFrontend = true
			}
		}
	}
	faroMu.Unlock()

	// Convert map to slice
	result := make([]queries.ServiceSummary, 0, len(serviceMap))
	for _, s := range serviceMap {
		result = append(result, *s)
	}

	return result
}

func valuesToDataPoints(values []queries.PromValue) []queries.DataPoint {
	pts := make([]queries.DataPoint, len(values))
	for i, v := range values {
		pts[i] = queries.DataPoint{Timestamp: v.Timestamp(), Value: v.Float()}
	}
	return pts
}

func roundTo(val float64, decimals int) float64 {
	pow := math.Pow(10, float64(decimals))
	return math.Round(val*pow) / pow
}

func parseUnixParam(req *http.Request, name string, defaultVal time.Time) time.Time {
	s := req.URL.Query().Get(name)
	if s == "" {
		return defaultVal
	}
	ts, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return defaultVal
	}
	return time.Unix(ts, 0)
}

func parseDurationParam(req *http.Request, name string, defaultVal time.Duration) time.Duration {
	s := req.URL.Query().Get(name)
	if s == "" {
		return defaultVal
	}
	secs, err := strconv.Atoi(s)
	if err != nil {
		return defaultVal
	}
	return time.Duration(secs) * time.Second
}

// cachedOrDetectCapabilities returns cached capabilities or detects fresh ones.
// Uses the same negative-cache TTL (30s) as handleCapabilities to ensure
// consistent recovery across all endpoints.
func (a *App) cachedOrDetectCapabilities(ctx context.Context) queries.Capabilities {
	a.capMu.RLock()
	cached := a.capCache
	a.capMu.RUnlock()

	if cached != nil {
		ttl := capabilitiesCacheTTL
		if !cached.caps.SpanMetrics.Detected {
			ttl = capabilitiesNegativeTTL
		}
		if time.Since(cached.fetchedAt) < ttl {
			return cached.caps
		}
	}

	caps := a.detectCapabilities(ctx, httpHeaders(ctx))
	a.capMu.Lock()
	a.capCache = &cachedCapabilities{caps: caps, fetchedAt: time.Now()}
	a.capMu.Unlock()
	return caps
}
