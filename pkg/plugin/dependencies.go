package plugin

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// DependencySummary represents an external dependency (DB, cache, API).
type DependencySummary struct {
	Name         string  `json:"name"`
	Type         string  `json:"type"`
	Rate         float64 `json:"rate"`
	ErrorRate    float64 `json:"errorRate"`
	P95Duration  float64 `json:"p95Duration"`
	DurationUnit string  `json:"durationUnit"`
	Impact       float64 `json:"impact"`
}

// DependenciesResponse wraps a list of dependencies.
type DependenciesResponse struct {
	Dependencies []DependencySummary `json:"dependencies"`
}

// handleServiceDependencies returns downstream dependencies for a specific service.
// GET /services/{namespace}/{service}/dependencies?from=&to=
func (a *App) handleServiceDependencies(w http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	service := queries.MustSanitizeLabel(req.PathValue("service"))
	namespace := queries.MustSanitizeLabel(req.PathValue("namespace"))

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.ServiceGraph.Detected {
		writeJSON(w, DependenciesResponse{Dependencies: []DependencySummary{}})
		return
	}

	now := time.Now()
	to := parseUnixParam(req, "to", now)

	deps := a.queryDependencies(ctx, to, service, "", namespace)
	writeJSON(w, DependenciesResponse{Dependencies: deps})
}

// handleGlobalDependencies returns all external dependencies across all services.
// GET /dependencies?from=&to=
func (a *App) handleGlobalDependencies(w http.ResponseWriter, req *http.Request) {
	ctx := req.Context()

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.ServiceGraph.Detected {
		writeJSON(w, DependenciesResponse{Dependencies: []DependencySummary{}})
		return
	}

	now := time.Now()
	to := parseUnixParam(req, "to", now)

	deps := a.queryDependencies(ctx, to, "", "", "")
	writeJSON(w, DependenciesResponse{Dependencies: deps})
}

// handleDependencyDetail returns RED metrics and upstream services for a specific dependency.
// GET /dependencies/{name}?from=&to=
func (a *App) handleDependencyDetail(w http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	depName := queries.MustSanitizeLabel(req.PathValue("name"))

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.ServiceGraph.Detected {
		writeJSON(w, DependencyDetailResponse{
			Dependency: DependencySummary{Name: depName},
			Upstreams:  []DependencySummary{},
			Operations: []queries.OperationSummary{},
		})
		return
	}

	now := time.Now()
	to := parseUnixParam(req, "to", now)

	detail := a.queryDependencyDetail(ctx, caps, to, depName)
	writeJSON(w, detail)
}

// DependencyDetailResponse contains dependency info plus upstream callers and operations.
type DependencyDetailResponse struct {
	Dependency DependencySummary          `json:"dependency"`
	Upstreams  []DependencySummary        `json:"upstreams"`
	Operations []queries.OperationSummary `json:"operations"`
}

// queryDependencies queries servicegraph metrics for dependencies.
// If filterClient is set, only returns dependencies called by that service.
// If filterNamespace is set, scopes to that client_service_namespace.
func (a *App) queryDependencies(
	ctx context.Context,
	to time.Time,
	filterClient string,
	filterServer string,
	filterNamespace string,
) []DependencySummary {
	logger := log.DefaultLogger.With("handler", "dependencies")
	rangeStr := "[5m]"

	// Build label filter
	filters := []string{}
	if filterClient != "" {
		filters = append(filters, fmt.Sprintf(`client="%s"`, filterClient))
	}
	if filterServer != "" {
		filters = append(filters, fmt.Sprintf(`server="%s"`, filterServer))
	}
	// Note: service graph metrics don't carry namespace labels
	// (only client, server, connection_type, client_db_system).
	// Namespace filtering is not possible at the PromQL level for service graph data.
	// Only virtual_node connections (external dependencies) unless filtering by server
	if filterServer == "" {
		filters = append(filters, `connection_type="virtual_node"`)
	}

	labelFilter := ""
	for i, f := range filters {
		if i > 0 {
			labelFilter += ", "
		}
		labelFilter += f
	}

	rateQuery := fmt.Sprintf(
		`sum by (client, server, connection_type) (rate(traces_service_graph_request_total{%s}%s))`,
		labelFilter, rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (client, server, connection_type) (rate(traces_service_graph_request_failed_total{%s}%s))`,
		labelFilter, rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (server, le) (rate(traces_service_graph_request_server_seconds_bucket{%s}%s)))`,
		labelFilter, rangeStr,
	)

	type queryResult struct {
		name    string
		results []queries.PromResult
		err     error
	}

	var wg sync.WaitGroup
	ch := make(chan queryResult, 3)

	for _, q := range []struct {
		name  string
		query string
	}{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p95", p95Query},
	} {
		wg.Add(1)
		go func(n, query string) {
			defer wg.Done()
			results, err := a.promClient.InstantQuery(ctx, query, to)
			ch <- queryResult{name: n, results: results, err: err}
		}(q.name, q.query)
	}

	go func() {
		wg.Wait()
		close(ch)
	}()

	resultMap := make(map[string][]queries.PromResult)
	for r := range ch {
		if r.err != nil {
			logger.Warn("Dependencies query failed", "query", r.name, "error", r.err)
			continue
		}
		resultMap[r.name] = r.results
	}

	// Aggregate by dependency (server name)
	type depData struct {
		rate      float64
		errorRate float64
		p95       float64
		connType  string
	}
	deps := make(map[string]*depData)

	for _, r := range resultMap["rate"] {
		server := r.Metric["server"]
		if server == "" {
			continue
		}
		d, ok := deps[server]
		if !ok {
			d = &depData{}
			deps[server] = d
		}
		d.rate += r.Value.Float()
		d.connType = r.Metric["connection_type"]
	}

	for _, r := range resultMap["error"] {
		server := r.Metric["server"]
		if server == "" {
			continue
		}
		if d, ok := deps[server]; ok {
			d.errorRate += r.Value.Float()
		}
	}

	for _, r := range resultMap["p95"] {
		server := r.Metric["server"]
		if server == "" {
			continue
		}
		if d, ok := deps[server]; ok {
			v := r.Value.Float()
			if !math.IsNaN(v) && !math.IsInf(v, 0) {
				d.p95 = v
			}
		}
	}

	// Calculate total impact denominator
	totalImpact := 0.0
	for _, d := range deps {
		totalImpact += d.p95 * d.rate
	}

	// Build response — skip entries with empty or placeholder names
	result := make([]DependencySummary, 0, len(deps))
	for name, d := range deps {
		if name == "" || name == "unknown" || name == "<unknown>" {
			continue
		}
		errPct := 0.0
		if d.rate > 0 {
			errPct = (d.errorRate / d.rate) * 100
		}
		impact := 0.0
		if totalImpact > 0 {
			impact = (d.p95 * d.rate) / totalImpact
		}
		result = append(result, DependencySummary{
			Name:         name,
			Type:         inferDependencyType(name, d.connType),
			Rate:         roundTo(d.rate, 3),
			ErrorRate:    roundTo(errPct, 2),
			P95Duration:  roundTo(d.p95*1000, 2), // seconds → milliseconds
			DurationUnit: "ms",
			Impact:       roundTo(impact, 4),
		})
	}

	// Sort by impact descending
	sort.Slice(result, func(i, j int) bool {
		return result[i].Impact > result[j].Impact
	})

	if result == nil {
		result = []DependencySummary{}
	}
	return result
}

// queryDependencyDetail returns RED metrics + upstream callers + operations for a dependency.
func (a *App) queryDependencyDetail(
	ctx context.Context,
	caps queries.Capabilities,
	to time.Time,
	depName string,
) DependencyDetailResponse {
	logger := log.DefaultLogger.With("handler", "dependency-detail", "dep", depName)
	rangeStr := "[5m]"
	labelFilter := fmt.Sprintf(`server="%s"`, depName)

	// Query upstream services (by client)
	rateQuery := fmt.Sprintf(
		`sum by (client, server) (rate(traces_service_graph_request_total{%s}%s))`,
		labelFilter, rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (client, server) (rate(traces_service_graph_request_failed_total{%s}%s))`,
		labelFilter, rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (client, le) (rate(traces_service_graph_request_server_seconds_bucket{%s}%s)))`,
		labelFilter, rangeStr,
	)

	type queryResult struct {
		name    string
		results []queries.PromResult
		err     error
	}

	var wg sync.WaitGroup
	ch := make(chan queryResult, 3)

	for _, q := range []struct {
		name  string
		query string
	}{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p95", p95Query},
	} {
		wg.Add(1)
		go func(n, query string) {
			defer wg.Done()
			results, err := a.promClient.InstantQuery(ctx, query, to)
			ch <- queryResult{name: n, results: results, err: err}
		}(q.name, q.query)
	}

	go func() {
		wg.Wait()
		close(ch)
	}()

	resultMap := make(map[string][]queries.PromResult)
	for r := range ch {
		if r.err != nil {
			logger.Warn("Dependency detail query failed", "query", r.name, "error", r.err)
			continue
		}
		resultMap[r.name] = r.results
	}

	// Aggregate upstreams by client
	type upstreamData struct {
		rate      float64
		errorRate float64
		p95       float64
	}
	upstreams := make(map[string]*upstreamData)
	totalRate := 0.0
	totalError := 0.0
	totalP95 := 0.0

	for _, r := range resultMap["rate"] {
		client := r.Metric["client"]
		if client == "" {
			continue
		}
		u, ok := upstreams[client]
		if !ok {
			u = &upstreamData{}
			upstreams[client] = u
		}
		v := r.Value.Float()
		u.rate += v
		totalRate += v
	}

	for _, r := range resultMap["error"] {
		client := r.Metric["client"]
		if client == "" {
			continue
		}
		if u, ok := upstreams[client]; ok {
			v := r.Value.Float()
			u.errorRate += v
			totalError += v
		}
	}

	for _, r := range resultMap["p95"] {
		client := r.Metric["client"]
		if client == "" {
			continue
		}
		if u, ok := upstreams[client]; ok {
			v := r.Value.Float()
			if !math.IsNaN(v) && !math.IsInf(v, 0) {
				u.p95 = v
				if v > totalP95 {
					totalP95 = v
				}
			}
		}
	}

	// Build upstreams list
	totalImpact := 0.0
	for _, u := range upstreams {
		totalImpact += u.p95 * u.rate
	}

	upstreamList := make([]DependencySummary, 0, len(upstreams))
	for name, u := range upstreams {
		errPct := 0.0
		if u.rate > 0 {
			errPct = (u.errorRate / u.rate) * 100
		}
		impact := 0.0
		if totalImpact > 0 {
			impact = (u.p95 * u.rate) / totalImpact
		}
		upstreamList = append(upstreamList, DependencySummary{
			Name:         name,
			Type:         "service",
			Rate:         roundTo(u.rate, 3),
			ErrorRate:    roundTo(errPct, 2),
			P95Duration:  roundTo(u.p95*1000, 2),
			DurationUnit: "ms",
			Impact:       roundTo(impact, 4),
		})
	}

	sort.Slice(upstreamList, func(i, j int) bool {
		return upstreamList[i].Impact > upstreamList[j].Impact
	})

	// Build aggregate dependency summary
	errPct := 0.0
	if totalRate > 0 {
		errPct = (totalError / totalRate) * 100
	}

	// Query operations that target this dependency via spanmetrics peer_service dimension
	operations := a.queryDependencyOperations(ctx, caps, to, depName)

	return DependencyDetailResponse{
		Dependency: DependencySummary{
			Name:         depName,
			Type:         inferDependencyType(depName, ""),
			Rate:         roundTo(totalRate, 3),
			ErrorRate:    roundTo(errPct, 2),
			P95Duration:  roundTo(totalP95*1000, 2),
			DurationUnit: "ms",
		},
		Upstreams:  upstreamList,
		Operations: operations,
	}
}

// queryDependencyOperations queries spanmetrics for operations calling this dependency.
// Uses peer_service label from spanmetrics connector dimensions.
func (a *App) queryDependencyOperations(
	ctx context.Context,
	caps queries.Capabilities,
	to time.Time,
	depName string,
) []queries.OperationSummary {
	logger := log.DefaultLogger.With("handler", "dependency-operations", "dep", depName)
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
	labelFilter := fmt.Sprintf(`peer_service="%s", span_kind="SPAN_KIND_CLIENT"`, depName)

	rateQuery := fmt.Sprintf(
		`sum by (span_name, service_name) (rate(%s{%s}%s))`,
		callsMetric, labelFilter, rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (span_name, service_name) (rate(%s{%s, status_code="STATUS_CODE_ERROR"}%s))`,
		callsMetric, labelFilter, rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (span_name, service_name, le) (rate(%s{%s}%s)))`,
		durationBucket, labelFilter, rangeStr,
	)

	type queryResult struct {
		name    string
		results []queries.PromResult
		err     error
	}

	var wg sync.WaitGroup
	ch := make(chan queryResult, 3)

	for _, q := range []struct {
		name  string
		query string
	}{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p95", p95Query},
	} {
		wg.Add(1)
		go func(n, query string) {
			defer wg.Done()
			results, err := a.promClient.InstantQuery(ctx, query, to)
			ch <- queryResult{name: n, results: results, err: err}
		}(q.name, q.query)
	}

	go func() {
		wg.Wait()
		close(ch)
	}()

	resultMap := make(map[string][]queries.PromResult)
	for r := range ch {
		if r.err != nil {
			logger.Warn("Dep operations query failed", "query", r.name, "error", r.err)
			continue
		}
		resultMap[r.name] = r.results
	}

	type opKey struct {
		spanName    string
		serviceName string
	}
	opsMap := make(map[opKey]*queries.OperationSummary)
	getOrCreate := func(r queries.PromResult) *queries.OperationSummary {
		k := opKey{
			spanName:    r.Metric["span_name"],
			serviceName: r.Metric["service_name"],
		}
		if o, ok := opsMap[k]; ok {
			return o
		}
		o := &queries.OperationSummary{
			SpanName:     k.spanName,
			SpanKind:     k.serviceName, // Use service_name as "kind" for dep operations
			DurationUnit: durationUnit,
		}
		opsMap[k] = o
		return o
	}

	for _, r := range resultMap["rate"] {
		o := getOrCreate(r)
		o.Rate = roundTo(r.Value.Float(), 3)
	}
	for _, r := range resultMap["error"] {
		o := getOrCreate(r)
		if o.Rate > 0 {
			o.ErrorRate = roundTo(r.Value.Float()/o.Rate*100, 2)
		}
	}
	for _, r := range resultMap["p95"] {
		o := getOrCreate(r)
		v := r.Value.Float()
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			o.P95Duration = roundTo(v, 2)
		}
	}

	ops := make([]queries.OperationSummary, 0, len(opsMap))
	for _, o := range opsMap {
		ops = append(ops, *o)
	}
	return ops
}

// inferDependencyType maps a dependency name to a type for icon display.
func inferDependencyType(name, connType string) string {
	switch name {
	case "redis", "valkey":
		return "redis"
	case "postgresql", "postgres":
		return "postgresql"
	case "mysql", "mariadb":
		return "mysql"
	case "mongodb", "mongo":
		return "mongodb"
	case "elasticsearch", "opensearch":
		return "elasticsearch"
	case "kafka":
		return "kafka"
	case "rabbitmq", "amqp":
		return "rabbitmq"
	case "memcached":
		return "memcached"
	}

	if connType == "virtual_node" {
		return "external"
	}
	return "service"
}

// ConnectedService represents a service connected via service graph.
type ConnectedService struct {
	Name         string  `json:"name"`
	Rate         float64 `json:"rate"`
	ErrorRate    float64 `json:"errorRate"`
	P95Duration  float64 `json:"p95Duration"`
	DurationUnit string  `json:"durationUnit"`
}

// ConnectedServicesResponse contains inbound and outbound service connections.
type ConnectedServicesResponse struct {
	Inbound  []ConnectedService `json:"inbound"`
	Outbound []ConnectedService `json:"outbound"`
}

// handleConnectedServices returns inbound and outbound service connections.
// GET /services/{namespace}/{service}/connected?from=&to=
func (a *App) handleConnectedServices(w http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	service := queries.MustSanitizeLabel(req.PathValue("service"))

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.ServiceGraph.Detected {
		writeJSON(w, ConnectedServicesResponse{
			Inbound:  []ConnectedService{},
			Outbound: []ConnectedService{},
		})
		return
	}

	now := time.Now()
	to := parseUnixParam(req, "to", now)

	resp := a.queryConnectedServices(ctx, to, service)
	writeJSON(w, resp)
}

func (a *App) queryConnectedServices(ctx context.Context, to time.Time, service string) ConnectedServicesResponse {
	logger := log.DefaultLogger.With("handler", "connected-services")
	rangeStr := "[5m]"

	// Outbound: where service is the client (exclude virtual_node)
	outRateQ := fmt.Sprintf(
		`sum by (server) (rate(traces_service_graph_request_total{client="%s", connection_type!="virtual_node"}%s))`,
		service, rangeStr,
	)
	outErrQ := fmt.Sprintf(
		`sum by (server) (rate(traces_service_graph_request_failed_total{client="%s", connection_type!="virtual_node"}%s))`,
		service, rangeStr,
	)
	outP95Q := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (server, le) (rate(traces_service_graph_request_server_seconds_bucket{client="%s", connection_type!="virtual_node"}%s)))`,
		service, rangeStr,
	)

	// Inbound: where service is the server
	inRateQ := fmt.Sprintf(
		`sum by (client) (rate(traces_service_graph_request_total{server="%s"}%s))`,
		service, rangeStr,
	)
	inErrQ := fmt.Sprintf(
		`sum by (client) (rate(traces_service_graph_request_failed_total{server="%s"}%s))`,
		service, rangeStr,
	)
	inP95Q := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (client, le) (rate(traces_service_graph_request_server_seconds_bucket{server="%s"}%s)))`,
		service, rangeStr,
	)

	type queryResult struct {
		name    string
		results []queries.PromResult
		err     error
	}

	var wg sync.WaitGroup
	ch := make(chan queryResult, 6)

	for _, q := range []struct {
		name  string
		query string
	}{
		{"outRate", outRateQ}, {"outErr", outErrQ}, {"outP95", outP95Q},
		{"inRate", inRateQ}, {"inErr", inErrQ}, {"inP95", inP95Q},
	} {
		wg.Add(1)
		go func(n, query string) {
			defer wg.Done()
			results, err := a.promClient.InstantQuery(ctx, query, to)
			ch <- queryResult{name: n, results: results, err: err}
		}(q.name, q.query)
	}

	go func() {
		wg.Wait()
		close(ch)
	}()

	resultMap := make(map[string][]queries.PromResult)
	for r := range ch {
		if r.err != nil {
			logger.Warn("Connected services query failed", "query", r.name, "error", r.err)
			continue
		}
		resultMap[r.name] = r.results
	}

	buildList := func(rateKey, errKey, p95Key, peerLabel string) []ConnectedService {
		type svcData struct {
			rate  float64
			err   float64
			p95   float64
		}
		m := make(map[string]*svcData)
		for _, r := range resultMap[rateKey] {
			name := r.Metric[peerLabel]
			if name == "" {
				continue
			}
			d, ok := m[name]
			if !ok {
				d = &svcData{}
				m[name] = d
			}
			d.rate += r.Value.Float()
		}
		for _, r := range resultMap[errKey] {
			name := r.Metric[peerLabel]
			if d, ok := m[name]; ok {
				d.err += r.Value.Float()
			}
		}
		for _, r := range resultMap[p95Key] {
			name := r.Metric[peerLabel]
			if d, ok := m[name]; ok {
				v := r.Value.Float()
				if !math.IsNaN(v) && !math.IsInf(v, 0) {
					d.p95 = v
				}
			}
		}
		result := make([]ConnectedService, 0, len(m))
		for name, d := range m {
			errPct := 0.0
			if d.rate > 0 {
				errPct = (d.err / d.rate) * 100
			}
			result = append(result, ConnectedService{
				Name:         name,
				Rate:         roundTo(d.rate, 3),
				ErrorRate:    roundTo(errPct, 2),
				P95Duration:  roundTo(d.p95*1000, 2),
				DurationUnit: "ms",
			})
		}
		sort.Slice(result, func(i, j int) bool {
			return result[i].Rate > result[j].Rate
		})
		return result
	}

	outbound := buildList("outRate", "outErr", "outP95", "server")
	inbound := buildList("inRate", "inErr", "inP95", "client")

	if outbound == nil {
		outbound = []ConnectedService{}
	}
	if inbound == nil {
		inbound = []ConnectedService{}
	}

	return ConnectedServicesResponse{Inbound: inbound, Outbound: outbound}
}
