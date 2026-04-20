package plugin

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

func (a *App) handleEndpoints(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := req.Context()
	ctx = withAuthContext(ctx, a.promClientForRequest(req))
	namespace := queries.MustSanitizeLabel(req.PathValue("namespace"))
	service := queries.MustSanitizeLabel(req.PathValue("service"))

	if service == "" {
		http.Error(w, `{"error":"missing service"}`, http.StatusBadRequest)
		return
	}

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.SpanMetrics.Detected {
		writeJSON(w, queries.EndpointGroups{})
		return
	}

	now := time.Now()
	from := parseUnixParam(req, "from", now.Add(-1*time.Hour))
	to := parseUnixParam(req, "to", now)

	groups := a.queryEndpoints(ctx, caps, namespace, service, from, to)
	writeJSON(w, groups)
}

func (a *App) queryEndpoints(
	ctx context.Context,
	caps queries.Capabilities,
	namespace, service string,
	from, to time.Time,
) queries.EndpointGroups {
	logger := log.DefaultLogger.With("handler", "endpoints")
	callsMetric := caps.SpanMetrics.CallsMetric
	ns := caps.SpanMetrics.Namespace
	durationUnit := caps.SpanMetrics.DurationUnit

	durationBucket := ns + "_duration_" + durationUnit + "_bucket"
	if durationUnit == "ms" {
		durationBucket = ns + "_duration_milliseconds_bucket"
	} else if durationUnit == "s" {
		durationBucket = ns + "_duration_seconds_bucket"
	}

	rangeStr := "[5m]"

	baseFilter := fmt.Sprintf(`service_name="%s"`, service)
	if namespace != "" {
		baseFilter += fmt.Sprintf(`, service_namespace="%s"`, namespace)
	}

	// Define query groups for each protocol category
	type endpointCategory struct {
		name       string
		filter     string
		groupBy    string
		keyExtract func(queries.PromResult) queries.EndpointSummary
	}

	categories := []endpointCategory{
		{
			name:    "http",
			filter:  baseFilter + `, span_kind="SPAN_KIND_SERVER", http_route!=""`,
			groupBy: "http_route, http_method",
			keyExtract: func(r queries.PromResult) queries.EndpointSummary {
				return queries.EndpointSummary{
					SpanName:   r.Metric["http_method"] + " " + r.Metric["http_route"],
					HTTPMethod: r.Metric["http_method"],
					HTTPRoute:  r.Metric["http_route"],
				}
			},
		},
		{
			name:    "grpc",
			filter:  baseFilter + `, rpc_service!=""`,
			groupBy: "rpc_service, rpc_method",
			keyExtract: func(r queries.PromResult) queries.EndpointSummary {
				return queries.EndpointSummary{
					SpanName:   r.Metric["rpc_service"] + "/" + r.Metric["rpc_method"],
					RPCService: r.Metric["rpc_service"],
					RPCMethod:  r.Metric["rpc_method"],
				}
			},
		},
		{
			name:    "database",
			filter:  baseFilter + `, db_system!=""`,
			groupBy: "db_system, span_name",
			keyExtract: func(r queries.PromResult) queries.EndpointSummary {
				return queries.EndpointSummary{
					SpanName: r.Metric["span_name"],
					DBSystem: r.Metric["db_system"],
				}
			},
		},
		{
			name:    "internal",
			filter:  baseFilter + `, span_kind="SPAN_KIND_INTERNAL"`,
			groupBy: "span_name",
			keyExtract: func(r queries.PromResult) queries.EndpointSummary {
				return queries.EndpointSummary{
					SpanName: r.Metric["span_name"],
				}
			},
		},
	}

	groups := queries.EndpointGroups{
		DurationUnit: durationUnit,
		HTTP:         []queries.EndpointSummary{},
		GRPC:         []queries.EndpointSummary{},
		Database:     []queries.EndpointSummary{},
		Internal:     []queries.EndpointSummary{},
	}

	type categoryResult struct {
		name      string
		endpoints []queries.EndpointSummary
	}

	var wg sync.WaitGroup
	ch := make(chan categoryResult, len(categories))

	for _, cat := range categories {
		wg.Add(1)
		go func(c endpointCategory) {
			defer wg.Done()
			eps := a.queryEndpointCategory(ctx, logger, c.name, c.filter, c.groupBy,
				callsMetric, durationBucket, rangeStr, durationUnit, to, c.keyExtract)
			ch <- categoryResult{name: c.name, endpoints: eps}
		}(cat)
	}

	go func() {
		wg.Wait()
		close(ch)
	}()

	for r := range ch {
		switch r.name {
		case "http":
			groups.HTTP = r.endpoints
		case "grpc":
			groups.GRPC = r.endpoints
		case "database":
			groups.Database = r.endpoints
		case "internal":
			groups.Internal = r.endpoints
		}
	}

	return groups
}

func (a *App) queryEndpointCategory(
	ctx context.Context,
	logger log.Logger,
	category, filter, groupBy,
	callsMetric, durationBucket, rangeStr, durationUnit string,
	at time.Time,
	keyExtract func(queries.PromResult) queries.EndpointSummary,
) []queries.EndpointSummary {
	rateQ := fmt.Sprintf(`sum by (%s) (rate(%s{%s}%s))`, groupBy, callsMetric, filter, rangeStr)
	errorQ := fmt.Sprintf(`sum by (%s) (rate(%s{%s, status_code="STATUS_CODE_ERROR"}%s))`, groupBy, callsMetric, filter, rangeStr)
	p50Q := fmt.Sprintf(`histogram_quantile(0.50, sum by (%s, le) (rate(%s{%s}%s)))`, groupBy, durationBucket, filter, rangeStr)
	p95Q := fmt.Sprintf(`histogram_quantile(0.95, sum by (%s, le) (rate(%s{%s}%s)))`, groupBy, durationBucket, filter, rangeStr)
	p99Q := fmt.Sprintf(`histogram_quantile(0.99, sum by (%s, le) (rate(%s{%s}%s)))`, groupBy, durationBucket, filter, rangeStr)

	type qr struct {
		name    string
		results []queries.PromResult
		err     error
	}

	var wg sync.WaitGroup
	qch := make(chan qr, 5)

	for _, q := range []struct {
		name  string
		query string
	}{
		{"rate", rateQ},
		{"error", errorQ},
		{"p50", p50Q},
		{"p95", p95Q},
		{"p99", p99Q},
	} {
		wg.Add(1)
		go func(n, query string) {
			defer wg.Done()
			results, err := a.prom(ctx).InstantQuery(ctx, query, at)
			qch <- qr{name: n, results: results, err: err}
		}(q.name, q.query)
	}

	go func() {
		wg.Wait()
		close(qch)
	}()

	resultMap := make(map[string][]queries.PromResult)
	for r := range qch {
		if r.err != nil {
			logger.Warn("Endpoint query failed", "category", category, "query", r.name, "error", r.err)
			continue
		}
		resultMap[r.name] = r.results
	}

	// Build endpoint map keyed by span name
	epsMap := make(map[string]*queries.EndpointSummary)
	getOrCreate := func(r queries.PromResult) *queries.EndpointSummary {
		base := keyExtract(r)
		key := base.SpanName
		if ep, ok := epsMap[key]; ok {
			return ep
		}
		base.DurationUnit = durationUnit
		epsMap[key] = &base
		return &base
	}

	for _, r := range resultMap["rate"] {
		ep := getOrCreate(r)
		ep.Rate = roundTo(r.Value.Float(), 3)
	}
	for _, r := range resultMap["error"] {
		ep := getOrCreate(r)
		if ep.Rate > 0 {
			ep.ErrorRate = roundTo(r.Value.Float()/ep.Rate*100, 2)
		}
	}
	for _, r := range resultMap["p50"] {
		ep := getOrCreate(r)
		v := r.Value.Float()
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			ep.P50Duration = roundTo(v, 2)
		}
	}
	for _, r := range resultMap["p95"] {
		ep := getOrCreate(r)
		v := r.Value.Float()
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			ep.P95Duration = roundTo(v, 2)
		}
	}
	for _, r := range resultMap["p99"] {
		ep := getOrCreate(r)
		v := r.Value.Float()
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			ep.P99Duration = roundTo(v, 2)
		}
	}

	eps := make([]queries.EndpointSummary, 0, len(epsMap))
	for _, ep := range epsMap {
		eps = append(eps, *ep)
	}
	return eps
}
