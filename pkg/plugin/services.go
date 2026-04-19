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
	if req.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if a.promClient == nil {
		http.Error(w, "metrics datasource not configured", http.StatusServiceUnavailable)
		return
	}

	ctx := req.Context()

	// Parse time range from query params (defaults: last 1h)
	now := time.Now()
	from := parseUnixParam(req, "from", now.Add(-1*time.Hour))
	to := parseUnixParam(req, "to", now)
	step := parseDurationParam(req, "step", 60*time.Second)
	withSeries := req.URL.Query().Get("withSeries") != "false"

	// Get capability info for metric names
	a.capMu.RLock()
	cached := a.capCache
	a.capMu.RUnlock()

	var caps queries.Capabilities
	if cached != nil && time.Since(cached.fetchedAt) < capabilitiesCacheTTL {
		caps = cached.caps
	} else {
		caps = a.detectCapabilities(ctx)
		a.capMu.Lock()
		a.capCache = &cachedCapabilities{caps: caps, fetchedAt: time.Now()}
		a.capMu.Unlock()
	}

	if !caps.SpanMetrics.Detected {
		writeJSON(w, []queries.ServiceSummary{})
		return
	}

	services := a.fetchServiceSummaries(ctx, caps, from, to, step, withSeries)
	writeJSON(w, services)
}

func (a *App) fetchServiceSummaries(
	ctx context.Context,
	caps queries.Capabilities,
	from, to time.Time,
	step time.Duration,
	withSeries bool,
) []queries.ServiceSummary {
	logger := log.DefaultLogger.With("handler", "services")
	callsMetric := caps.SpanMetrics.CallsMetric
	ns := caps.SpanMetrics.Namespace
	durationUnit := caps.SpanMetrics.DurationUnit

	// Build duration histogram metric name (without _bucket suffix for histogram_quantile)
	durationBucket := ns + "_duration_" + durationUnit + "_bucket"
	if durationUnit == "ms" {
		durationBucket = ns + "_duration_milliseconds_bucket"
	} else if durationUnit == "s" {
		durationBucket = ns + "_duration_seconds_bucket"
	}

	rangeStr := "[5m]"

	// Queries: rate, error rate, P95 duration (all grouped by service_name, service_namespace)
	rateQuery := fmt.Sprintf(
		`sum by (service_name, service_namespace) (rate(%s{span_kind="SPAN_KIND_SERVER"}%s))`,
		callsMetric, rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (service_name, service_namespace) (rate(%s{span_kind="SPAN_KIND_SERVER", status_code="STATUS_CODE_ERROR"}%s))`,
		callsMetric, rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (service_name, service_namespace, le) (rate(%s{span_kind="SPAN_KIND_SERVER"}%s)))`,
		durationBucket, rangeStr,
	)
	// SDK language from telemetry_sdk_language label on span metrics
	sdkQuery := fmt.Sprintf(
		`group by (service_name, service_namespace, telemetry_sdk_language) (%s)`,
		callsMetric,
	)

	type queryResult struct {
		name    string
		results []queries.PromResult
		err     error
	}

	// Run instant queries in parallel
	var wg sync.WaitGroup
	ch := make(chan queryResult, 6)

	instantQueries := map[string]string{
		"rate":  rateQuery,
		"error": errorQuery,
		"p95":   p95Query,
		"sdk":   sdkQuery,
	}

	for name, q := range instantQueries {
		wg.Add(1)
		go func(n, query string) {
			defer wg.Done()
			results, err := a.promClient.InstantQuery(ctx, query, to)
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
				results, err := a.promClient.RangeQuery(ctx, query, from, to, step)
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

	// Build service map keyed by "namespace/name"
	type serviceKey struct {
		name      string
		namespace string
	}

	serviceMap := make(map[serviceKey]*queries.ServiceSummary)
	getOrCreate := func(r queries.PromResult) *queries.ServiceSummary {
		k := serviceKey{
			name:      r.Metric["service_name"],
			namespace: r.Metric["service_namespace"],
		}
		if s, ok := serviceMap[k]; ok {
			return s
		}
		s := &queries.ServiceSummary{
			Name:         k.name,
			Namespace:    k.namespace,
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
			s.ErrorRate = roundTo(r.Value.Float()/s.Rate*100, 2)
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

	// Fill SDK language
	for _, r := range resultMap["sdk"] {
		s := getOrCreate(r)
		if lang, ok := r.Metric["telemetry_sdk_language"]; ok && lang != "" && s.SDKLanguage == "" {
			s.SDKLanguage = lang
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
