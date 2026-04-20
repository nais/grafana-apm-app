package plugin

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
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
	if !requireGET(w, req) {
		return
	}
	ctx := req.Context()
	ctx = withAuthContext(ctx, a.promClientForRequest(req))
	service := queries.MustSanitizeLabel(req.PathValue("service"))
	namespace := queries.MustSanitizeLabel(req.PathValue("namespace"))

	if !requireServiceParam(w, service) {
		return
	}

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
	if !requireGET(w, req) {
		return
	}
	ctx := req.Context()
	ctx = withAuthContext(ctx, a.promClientForRequest(req))

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
	if !requireGET(w, req) {
		return
	}
	ctx := req.Context()
	ctx = withAuthContext(ctx, a.promClientForRequest(req))
	depName := queries.MustSanitizeLabel(req.PathValue("name"))

	if depName == "" {
		http.Error(w, `{"error":"missing or invalid dependency name"}`, http.StatusBadRequest)
		return
	}

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.ServiceGraph.Detected {
		writeJSON(w, DependencyDetailResponse{
			Dependency: DependencySummary{Name: depName},
			Upstreams:  []DependencySummary{},
			Operations: []queries.DependencyOperation{},
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
	Dependency DependencySummary              `json:"dependency"`
	Upstreams  []DependencySummary            `json:"upstreams"`
	Operations []queries.DependencyOperation  `json:"operations"`
}

// depKey uniquely identifies a dependency by server name and connection type.
type depKey struct {
	server   string
	connType string
}

func (k depKey) String() string {
	if k.connType == "" {
		return k.server
	}
	return k.server + "|" + k.connType
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
	sgp := a.serviceGraphPrefix()
	ct := a.otelCfg.Labels.ConnectionType

	// Build label filter
	filters := []string{}
	if filterClient != "" {
		filters = append(filters, fmt.Sprintf(`%s="%s"`, a.otelCfg.Labels.Client, filterClient))
	}
	if filterServer != "" {
		filters = append(filters, fmt.Sprintf(`%s="%s"`, a.otelCfg.Labels.Server, filterServer))
	}

	labelFilter := ""
	for i, f := range filters {
		if i > 0 {
			labelFilter += ", "
		}
		labelFilter += f
	}

	// Include connection_type in group-by to preserve dependency classification.
	rateQuery := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s%s{%s}%s))`,
		a.otelCfg.Labels.Client, a.otelCfg.Labels.Server, ct,
		sgp, a.otelCfg.ServiceGraph.RequestTotal, labelFilter, rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s%s{%s}%s))`,
		a.otelCfg.Labels.Client, a.otelCfg.Labels.Server, ct,
		sgp, a.otelCfg.ServiceGraph.RequestFailedTotal, labelFilter, rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s%s{%s}%s)))`,
		a.otelCfg.Labels.Server, ct, a.otelCfg.Labels.Le,
		sgp, a.otelCfg.ServiceGraph.RequestServerBucket, labelFilter, rangeStr,
	)

	// Enrichment: query spanmetrics for specific db_system per server_address.
	// Only fetches for database-type dependencies to resolve postgresql vs oracle etc.
	dbEnrichQuery := fmt.Sprintf(
		`count by (%s, %s) (rate(%s{%s!="", %s="%s"}%s))`,
		a.otelCfg.Labels.ServerAddress, a.otelCfg.Labels.DBSystem,
		a.callsMetric(ctx), a.otelCfg.Labels.DBSystem, a.otelCfg.Labels.SpanKind, a.otelCfg.SpanKinds.Client,
		rangeStr,
	)

	type queryResult struct {
		name    string
		results []queries.PromResult
		err     error
	}

	var wg sync.WaitGroup
	ch := make(chan queryResult, 4)

	for _, q := range []struct {
		name  string
		query string
	}{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p95", p95Query},
		{"db_enrich", dbEnrichQuery},
	} {
		wg.Add(1)
		go func(n, query string) {
			defer wg.Done()
			results, err := a.prom(ctx).InstantQuery(ctx, query, to)
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

	// Build server_address → db_system mapping from enrichment query
	dbSystemMap := make(map[string]string) // server_address → db_system
	for _, r := range resultMap["db_enrich"] {
		addr := r.Metric[a.otelCfg.Labels.ServerAddress]
		dbSys := r.Metric[a.otelCfg.Labels.DBSystem]
		if addr != "" && dbSys != "" {
			dbSystemMap[addr] = dbSys
		}
	}

	// Aggregate by (server, connection_type)
	type depData struct {
		rate      float64
		errorRate float64
		p95       float64
	}
	deps := make(map[depKey]*depData)

	for _, r := range resultMap["rate"] {
		server := r.Metric[a.otelCfg.Labels.Server]
		if server == "" {
			continue
		}
		k := depKey{server: server, connType: r.Metric[ct]}
		d, ok := deps[k]
		if !ok {
			d = &depData{}
			deps[k] = d
		}
		d.rate += r.Value.Float()
	}

	for _, r := range resultMap["error"] {
		server := r.Metric[a.otelCfg.Labels.Server]
		if server == "" {
			continue
		}
		k := depKey{server: server, connType: r.Metric[ct]}
		if d, ok := deps[k]; ok {
			d.errorRate += r.Value.Float()
		}
	}

	for _, r := range resultMap["p95"] {
		server := r.Metric[a.otelCfg.Labels.Server]
		if server == "" {
			continue
		}
		k := depKey{server: server, connType: r.Metric[ct]}
		if d, ok := deps[k]; ok {
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
	for key, d := range deps {
		if key.server == "" || key.server == "unknown" || key.server == "<unknown>" {
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
			Name:         key.server,
			Type:         classifyDependency(key.server, key.connType, dbSystemMap),
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
	sgp := a.serviceGraphPrefix()
	labelFilter := fmt.Sprintf(`%s="%s"`, a.otelCfg.Labels.Server, depName)

	// Query upstream services (by client)
	rateQuery := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s%s{%s}%s))`,
		a.otelCfg.Labels.Client, a.otelCfg.Labels.Server, a.otelCfg.Labels.ConnectionType,
		sgp, a.otelCfg.ServiceGraph.RequestTotal, labelFilter, rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s%s{%s}%s))`,
		a.otelCfg.Labels.Client, a.otelCfg.Labels.Server, a.otelCfg.Labels.ConnectionType,
		sgp, a.otelCfg.ServiceGraph.RequestFailedTotal, labelFilter, rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s) (rate(%s%s{%s}%s)))`,
		a.otelCfg.Labels.Client, a.otelCfg.Labels.Le,
		sgp, a.otelCfg.ServiceGraph.RequestServerBucket, labelFilter, rangeStr,
	)
	// Enrichment for specific DB type
	dbEnrichQuery := fmt.Sprintf(
		`count by (%s, %s) (rate(%s{%s="%s", %s!="", %s="%s"}%s))`,
		a.otelCfg.Labels.ServerAddress, a.otelCfg.Labels.DBSystem,
		a.callsMetric(ctx),
		a.otelCfg.Labels.ServerAddress, depName,
		a.otelCfg.Labels.DBSystem,
		a.otelCfg.Labels.SpanKind, a.otelCfg.SpanKinds.Client,
		rangeStr,
	)

	type queryResult struct {
		name    string
		results []queries.PromResult
		err     error
	}

	var wg sync.WaitGroup
	ch := make(chan queryResult, 4)

	for _, q := range []struct {
		name  string
		query string
	}{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p95", p95Query},
		{"db_enrich", dbEnrichQuery},
	} {
		wg.Add(1)
		go func(n, query string) {
			defer wg.Done()
			results, err := a.prom(ctx).InstantQuery(ctx, query, to)
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

	// Build db_system map from enrichment
	dbSystemMap := make(map[string]string)
	for _, r := range resultMap["db_enrich"] {
		addr := r.Metric[a.otelCfg.Labels.ServerAddress]
		dbSys := r.Metric[a.otelCfg.Labels.DBSystem]
		if addr != "" && dbSys != "" {
			dbSystemMap[addr] = dbSys
		}
	}

	// Extract connection_type from any result
	detectedConnType := ""
	for _, r := range resultMap["rate"] {
		if ct := r.Metric[a.otelCfg.Labels.ConnectionType]; ct != "" {
			detectedConnType = ct
			break
		}
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
		client := r.Metric[a.otelCfg.Labels.Client]
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
		client := r.Metric[a.otelCfg.Labels.Client]
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
		client := r.Metric[a.otelCfg.Labels.Client]
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
			Type:         classifyDependency(depName, detectedConnType, dbSystemMap),
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
) []queries.DependencyOperation {
	logger := log.DefaultLogger.With("handler", "dependency-operations", "dep", depName)
	callsMetric := caps.SpanMetrics.CallsMetric
	durationUnit := caps.SpanMetrics.DurationUnit
	durationBucket := caps.SpanMetrics.DurationMetric

	rangeStr := "[5m]"
	labelFilter := fmt.Sprintf(`peer_service="%s", %s="%s"`, depName, a.otelCfg.Labels.SpanKind, a.otelCfg.SpanKinds.Client)

	rateQuery := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s{%s}%s))`,
		a.otelCfg.Labels.SpanName, a.otelCfg.Labels.ServiceName,
		callsMetric, labelFilter, rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s{%s, %s="%s"}%s))`,
		a.otelCfg.Labels.SpanName, a.otelCfg.Labels.ServiceName,
		callsMetric, labelFilter, a.otelCfg.Labels.StatusCode, a.otelCfg.StatusCodes.Error, rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s{%s}%s)))`,
		a.otelCfg.Labels.SpanName, a.otelCfg.Labels.ServiceName, a.otelCfg.Labels.Le,
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
			results, err := a.prom(ctx).InstantQuery(ctx, query, to)
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
	opsMap := make(map[opKey]*queries.DependencyOperation)
	getOrCreate := func(r queries.PromResult) *queries.DependencyOperation {
		k := opKey{
			spanName:    r.Metric[a.otelCfg.Labels.SpanName],
			serviceName: r.Metric[a.otelCfg.Labels.ServiceName],
		}
		if o, ok := opsMap[k]; ok {
			return o
		}
		o := &queries.DependencyOperation{
			SpanName:       k.spanName,
			CallingService: k.serviceName,
			DurationUnit:   durationUnit,
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
			o.ErrorRate = math.Min(roundTo(r.Value.Float()/o.Rate*100, 2), 100)
		}
	}
	for _, r := range resultMap["p95"] {
		o := getOrCreate(r)
		v := r.Value.Float()
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			o.P95Duration = roundTo(v, 2)
		}
	}

	ops := make([]queries.DependencyOperation, 0, len(opsMap))
	for _, o := range opsMap {
		ops = append(ops, *o)
	}
	return ops
}

// classifyDependency determines the dependency type using service-graph
// connection_type and optionally enriching database types from spanmetrics.
func classifyDependency(name, connType string, dbSystemMap map[string]string) string {
	switch connType {
	case "database":
		// Try to resolve specific DB type from spanmetrics enrichment
		if dbSys, ok := dbSystemMap[name]; ok {
			return normalizeDBSystem(dbSys)
		}
		// Fallback: try hostname pattern matching
		return inferDBFromHostname(name)

	case "messaging_system":
		return "kafka" // dominant messaging system; refined below if needed

	case "virtual_node":
		return "external"
	}

	// No connection_type — check if we can still classify by name patterns
	if dbSys, ok := dbSystemMap[name]; ok {
		return normalizeDBSystem(dbSys)
	}
	return inferFromName(name)
}

// normalizeDBSystem maps OTel db.system values to our display types.
func normalizeDBSystem(dbSys string) string {
	switch dbSys {
	case "postgresql", "postgres":
		return "postgresql"
	case "oracle":
		return "oracle"
	case "mongodb", "mongo":
		return "mongodb"
	case "redis":
		return "redis"
	case "mysql", "mariadb":
		return "mysql"
	case "db2":
		return "db2"
	case "opensearch", "elasticsearch":
		return "opensearch"
	case "h2":
		return "h2"
	case "other_sql":
		return "database"
	default:
		return "database"
	}
}

// inferDBFromHostname uses hostname patterns common at Nav.
func inferDBFromHostname(name string) string {
	lower := strings.ToLower(name)
	if strings.HasPrefix(lower, "dmv") && strings.Contains(lower, "-scan") {
		return "oracle" // Oracle RAC scan listeners
	}
	if strings.HasPrefix(lower, "a01db") {
		return "postgresql" // Nav on-prem PostgreSQL hosts
	}
	if strings.Contains(lower, "redis") || strings.Contains(lower, "valkey") {
		return "redis"
	}
	if strings.Contains(lower, "opensearch") || strings.Contains(lower, "elastic") {
		return "opensearch"
	}
	if strings.Contains(lower, "mongo") {
		return "mongodb"
	}
	return "database"
}

// inferFromName classifies by name when no connection_type is available.
func inferFromName(name string) string {
	lower := strings.ToLower(name)
	switch {
	case lower == "redis" || lower == "valkey":
		return "redis"
	case lower == "kafka":
		return "kafka"
	case strings.Contains(lower, "redis") || strings.Contains(lower, "valkey") ||
		strings.HasSuffix(lower, ".aivencloud.com"):
		return "redis"
	default:
		return "service"
	}
}

// ConnectedService represents a service connected via service graph.
type ConnectedService struct {
	Name           string  `json:"name"`
	ConnectionType string  `json:"connectionType,omitempty"`
	Rate           float64 `json:"rate"`
	ErrorRate      float64 `json:"errorRate"`
	P95Duration    float64 `json:"p95Duration"`
	DurationUnit   string  `json:"durationUnit"`
}

// ConnectedServicesResponse contains inbound and outbound service connections.
type ConnectedServicesResponse struct {
	Inbound  []ConnectedService `json:"inbound"`
	Outbound []ConnectedService `json:"outbound"`
}

// handleConnectedServices returns inbound and outbound service connections.
// GET /services/{namespace}/{service}/connected?from=&to=
func (a *App) handleConnectedServices(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := req.Context()
	ctx = withAuthContext(ctx, a.promClientForRequest(req))
	service := queries.MustSanitizeLabel(req.PathValue("service"))

	if !requireServiceParam(w, service) {
		return
	}

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
	sgp := a.serviceGraphPrefix()

	// Outbound: where service is the client
	// Include connection_type to distinguish database, messaging, and service connections.
	outRateQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s%s{%s="%s"}%s))`,
		a.otelCfg.Labels.Server, a.otelCfg.Labels.ConnectionType,
		sgp, a.otelCfg.ServiceGraph.RequestTotal,
		a.otelCfg.Labels.Client, service, rangeStr,
	)
	outErrQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s%s{%s="%s"}%s))`,
		a.otelCfg.Labels.Server, a.otelCfg.Labels.ConnectionType,
		sgp, a.otelCfg.ServiceGraph.RequestFailedTotal,
		a.otelCfg.Labels.Client, service, rangeStr,
	)
	outP95Q := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s%s{%s="%s"}%s)))`,
		a.otelCfg.Labels.Server, a.otelCfg.Labels.ConnectionType, a.otelCfg.Labels.Le,
		sgp, a.otelCfg.ServiceGraph.RequestServerBucket,
		a.otelCfg.Labels.Client, service, rangeStr,
	)

	// Inbound: where service is the server
	inRateQ := fmt.Sprintf(
		`sum by (%s) (rate(%s%s{%s="%s"}%s))`,
		a.otelCfg.Labels.Client,
		sgp, a.otelCfg.ServiceGraph.RequestTotal,
		a.otelCfg.Labels.Server, service, rangeStr,
	)
	inErrQ := fmt.Sprintf(
		`sum by (%s) (rate(%s%s{%s="%s"}%s))`,
		a.otelCfg.Labels.Client,
		sgp, a.otelCfg.ServiceGraph.RequestFailedTotal,
		a.otelCfg.Labels.Server, service, rangeStr,
	)
	inP95Q := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s) (rate(%s%s{%s="%s"}%s)))`,
		a.otelCfg.Labels.Client, a.otelCfg.Labels.Le,
		sgp, a.otelCfg.ServiceGraph.RequestServerBucket,
		a.otelCfg.Labels.Server, service, rangeStr,
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
			results, err := a.prom(ctx).InstantQuery(ctx, query, to)
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
		type connKey struct {
			name           string
			connectionType string
		}
		type svcData struct {
			rate  float64
			err   float64
			p95   float64
		}
		m := make(map[connKey]*svcData)
		for _, r := range resultMap[rateKey] {
			name := r.Metric[peerLabel]
			if name == "" {
				continue
			}
			k := connKey{name: name, connectionType: r.Metric[a.otelCfg.Labels.ConnectionType]}
			d, ok := m[k]
			if !ok {
				d = &svcData{}
				m[k] = d
			}
			d.rate += r.Value.Float()
		}
		for _, r := range resultMap[errKey] {
			name := r.Metric[peerLabel]
			ct := r.Metric[a.otelCfg.Labels.ConnectionType]
			k := connKey{name: name, connectionType: ct}
			if d, ok := m[k]; ok {
				d.err += r.Value.Float()
			}
		}
		for _, r := range resultMap[p95Key] {
			name := r.Metric[peerLabel]
			ct := r.Metric[a.otelCfg.Labels.ConnectionType]
			k := connKey{name: name, connectionType: ct}
			if d, ok := m[k]; ok {
				v := r.Value.Float()
				if !math.IsNaN(v) && !math.IsInf(v, 0) {
					d.p95 = v
				}
			}
		}
		result := make([]ConnectedService, 0, len(m))
		for k, d := range m {
			errPct := 0.0
			if d.rate > 0 {
				errPct = (d.err / d.rate) * 100
			}
			result = append(result, ConnectedService{
				Name:           k.name,
				ConnectionType: k.connectionType,
				Rate:           roundTo(d.rate, 3),
				ErrorRate:      roundTo(errPct, 2),
				P95Duration:    roundTo(d.p95*1000, 2),
				DurationUnit:   "ms",
			})
		}
		sort.Slice(result, func(i, j int) bool {
			return result[i].Rate > result[j].Rate
		})
		return result
	}

	outbound := buildList("outRate", "outErr", "outP95", a.otelCfg.Labels.Server)
	inbound := buildList("inRate", "inErr", "inP95", a.otelCfg.Labels.Client)

	if outbound == nil {
		outbound = []ConnectedService{}
	}
	if inbound == nil {
		inbound = []ConnectedService{}
	}

	return ConnectedServicesResponse{Inbound: inbound, Outbound: outbound}
}
