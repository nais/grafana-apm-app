package plugin

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// httpMethods recognized when parsing span_name like "GET /path".
var httpMethods = map[string]bool{
	"GET": true, "POST": true, "PUT": true, "DELETE": true,
	"PATCH": true, "HEAD": true, "OPTIONS": true, "CONNECT": true, "TRACE": true,
}

// parseHTTPSpanName extracts the HTTP method and route from a span_name
// like "GET /some/path". Also handles bare methods like "GET".
// Returns (method, route) or ("", spanName) if no HTTP method is found.
func parseHTTPSpanName(name string) (method, route string) {
	if idx := strings.IndexByte(name, ' '); idx > 0 && idx < 10 {
		candidate := name[:idx]
		if httpMethods[candidate] {
			return candidate, strings.TrimSpace(name[idx+1:])
		}
	}
	// Bare HTTP method with no path (e.g., "GET")
	if httpMethods[name] {
		return name, ""
	}
	return "", name
}

func (a *App) handleEndpoints(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	namespace := queries.ParseNamespace(req.PathValue("namespace"))
	service := queries.MustSanitizeLabel(req.PathValue("service"))
	environment := queries.MustSanitizeLabel(req.URL.Query().Get("environment"))

	if !requireServiceParam(w, service) {
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

	groups := a.queryEndpoints(ctx, caps, namespace, service, environment, from, to)
	writeJSON(w, groups)
}

func (a *App) queryEndpoints(
	ctx context.Context,
	caps queries.Capabilities,
	namespace, service, environment string,
	_, to time.Time,
) queries.EndpointGroups {
	logger := log.DefaultLogger.With("handler", "endpoints")
	callsMetric := caps.SpanMetrics.CallsMetric
	durationUnit := caps.SpanMetrics.DurationUnit
	durationBucket := caps.SpanMetrics.DurationMetric

	rangeStr := "[5m]"

	baseFilter := a.otelCfg.ServiceFilter(service, namespace)
	if environment != "" {
		baseFilter += fmt.Sprintf(`, %s="%s"`, a.otelCfg.Labels.DeploymentEnv, environment)
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
			filter:  baseFilter + fmt.Sprintf(`, %s="%s"`, a.otelCfg.Labels.SpanKind, a.otelCfg.SpanKinds.Server),
			groupBy: a.otelCfg.Labels.SpanName,
			keyExtract: func(r queries.PromResult) queries.EndpointSummary {
				name := r.Metric[a.otelCfg.Labels.SpanName]
				method, route := parseHTTPSpanName(name)
				return queries.EndpointSummary{
					SpanName:   name,
					HTTPMethod: method,
					HTTPRoute:  route,
				}
			},
		},
		{
			name:    "grpc",
			filter:  baseFilter + fmt.Sprintf(`, %s!=""`, a.otelCfg.Labels.RPCService),
			groupBy: a.otelCfg.Labels.RPCService + ", " + a.otelCfg.Labels.RPCMethod,
			keyExtract: func(r queries.PromResult) queries.EndpointSummary {
				return queries.EndpointSummary{
					SpanName:   r.Metric[a.otelCfg.Labels.RPCService] + "/" + r.Metric[a.otelCfg.Labels.RPCMethod],
					RPCService: r.Metric[a.otelCfg.Labels.RPCService],
					RPCMethod:  r.Metric[a.otelCfg.Labels.RPCMethod],
				}
			},
		},
		{
			name:    "database",
			filter:  baseFilter + fmt.Sprintf(`, %s!=""`, a.otelCfg.Labels.DBSystem),
			groupBy: a.otelCfg.Labels.DBSystem + ", " + a.otelCfg.Labels.SpanName,
			keyExtract: func(r queries.PromResult) queries.EndpointSummary {
				return queries.EndpointSummary{
					SpanName: r.Metric[a.otelCfg.Labels.SpanName],
					DBSystem: r.Metric[a.otelCfg.Labels.DBSystem],
				}
			},
		},
		{
			name:    "messaging",
			filter:  baseFilter + fmt.Sprintf(`, %s=~"%s|%s"`, a.otelCfg.Labels.SpanKind, a.otelCfg.SpanKinds.Consumer, a.otelCfg.SpanKinds.Producer),
			groupBy: a.otelCfg.Labels.SpanName + ", " + a.otelCfg.Labels.SpanKind,
			keyExtract: func(r queries.PromResult) queries.EndpointSummary {
				kind := "Consumer"
				if r.Metric[a.otelCfg.Labels.SpanKind] == a.otelCfg.SpanKinds.Producer {
					kind = "Producer"
				}
				return queries.EndpointSummary{
					SpanName:      r.Metric[a.otelCfg.Labels.SpanName],
					MessagingKind: kind,
				}
			},
		},
		{
			name:    "internal",
			filter:  baseFilter + fmt.Sprintf(`, %s="%s"`, a.otelCfg.Labels.SpanKind, a.otelCfg.SpanKinds.Internal),
			groupBy: a.otelCfg.Labels.SpanName,
			keyExtract: func(r queries.PromResult) queries.EndpointSummary {
				return queries.EndpointSummary{
					SpanName: r.Metric[a.otelCfg.Labels.SpanName],
				}
			},
		},
	}

	groups := queries.EndpointGroups{
		DurationUnit: durationUnit,
		HTTP:         []queries.EndpointSummary{},
		GRPC:         []queries.EndpointSummary{},
		Database:     []queries.EndpointSummary{},
		Messaging:    []queries.EndpointSummary{},
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
			eps := a.queryEndpointCategory(ctx, logger, c.filter, c.groupBy,
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
			groups.HTTP = filterNoisyEndpoints(r.endpoints)
		case "grpc":
			groups.GRPC = r.endpoints
		case "database":
			groups.Database = r.endpoints
		case "messaging":
			groups.Messaging = r.endpoints
		case "internal":
			groups.Internal = r.endpoints
		}
	}

	return groups
}

func (a *App) queryEndpointCategory(
	ctx context.Context,
	logger log.Logger,
	filter, groupBy,
	callsMetric, durationBucket, rangeStr, durationUnit string,
	at time.Time,
	keyExtract func(queries.PromResult) queries.EndpointSummary,
) []queries.EndpointSummary {
	rateQ := otelconfig.Rate(callsMetric, filter, groupBy, rangeStr)
	errorQ := otelconfig.Rate(callsMetric, a.otelCfg.ErrorFilter(filter), groupBy, rangeStr)
	p50Q := otelconfig.Quantile(0.50, durationBucket, filter, groupBy, a.otelCfg.Labels.Le, rangeStr)
	p95Q := otelconfig.Quantile(0.95, durationBucket, filter, groupBy, a.otelCfg.Labels.Le, rangeStr)
	p99Q := otelconfig.Quantile(0.99, durationBucket, filter, groupBy, a.otelCfg.Labels.Le, rangeStr)

	resultMap := a.runInstantQueries(ctx, at, []QueryJob{
		{"rate", rateQ},
		{"error", errorQ},
		{"p50", p50Q},
		{"p95", p95Q},
		{"p99", p99Q},
	}, logger)

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
		ep.ErrorRate = calculateErrorRate(r.Value.Float(), ep.Rate)
	}
	for _, r := range resultMap["p50"] {
		ep := getOrCreate(r)
		v := r.Value.Float()
		if isValidMetricValue(v) {
			ep.P50Duration = roundTo(v, 2)
		}
	}
	for _, r := range resultMap["p95"] {
		ep := getOrCreate(r)
		v := r.Value.Float()
		if isValidMetricValue(v) {
			ep.P95Duration = roundTo(v, 2)
		}
	}
	for _, r := range resultMap["p99"] {
		ep := getOrCreate(r)
		v := r.Value.Float()
		if isValidMetricValue(v) {
			ep.P99Duration = roundTo(v, 2)
		}
	}

	eps := make([]queries.EndpointSummary, 0, len(epsMap))
	for _, ep := range epsMap {
		eps = append(eps, *ep)
	}
	return eps
}

// noisyPathSegments are framework-generated route segments that clutter the
// Server tab without providing actionable insight. Matched anywhere in the path.
var noisyPathSegments = []string{
	"/_next/",
	"/__next",
	"/_nuxt/",
	"/.well-known/",
	"/_app/",        // SvelteKit
	"/@vite/",       // Vite dev
	"/@fs/",         // Vite dev
	"/__webpack",    // Webpack dev
}

// noisyPathPrefixes are matched only at the start of the path.
var noisyPathPrefixes = []string{
	"/static/",
	"/assets/",
	"/public/",
}

// noisyPathSuffixes are static-content file extensions that are not
// interesting API routes.
var noisyPathSuffixes = []string{
	".js", ".css", ".map",
	".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".avif",
	".woff", ".woff2", ".ttf", ".eot",
	".xml", ".txt", ".webmanifest",
}

// noisyExactPaths are specific well-known static paths to filter.
var noisyExactPaths = map[string]bool{
	"/manifest.json":  true,
	"/robots.txt":     true,
	"/favicon.ico":    true,
	"/sitemap.xml":    true,
	"/browserconfig.xml": true,
}

// isNoisyRoute checks if a route is a framework-generated static asset path.
func isNoisyRoute(route string) bool {
	r := strings.ToLower(route)
	if noisyExactPaths[r] {
		return true
	}
	for _, seg := range noisyPathSegments {
		if strings.Contains(r, seg) {
			return true
		}
	}
	for _, p := range noisyPathPrefixes {
		if strings.HasPrefix(r, p) {
			return true
		}
	}
	for _, s := range noisyPathSuffixes {
		if strings.HasSuffix(r, s) {
			return true
		}
	}
	return false
}

// filterNoisyEndpoints removes framework-generated static asset routes from
// HTTP endpoint lists so users see only their real API endpoints.
func filterNoisyEndpoints(eps []queries.EndpointSummary) []queries.EndpointSummary {
	out := make([]queries.EndpointSummary, 0, len(eps))
	for _, ep := range eps {
		route := ep.HTTPRoute
		if route == "" {
			route = ep.SpanName
		}
		if !isNoisyRoute(route) {
			out = append(out, ep)
		}
	}
	return out
}
