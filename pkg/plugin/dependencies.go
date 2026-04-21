package plugin

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// normalizeAddress cleans up a server address / http_host value for display.
// It strips well-known ports (:443, :80) and trailing dots.
func normalizeAddress(addr string) string {
	if addr == "" {
		return ""
	}
	// Split host:port, strip trailing dot from host, then handle ports
	host, port, hasPort := strings.Cut(addr, ":")
	host = strings.TrimRight(host, ".")
	if hasPort {
		switch port {
		case "443", "80":
			return strings.ToLower(host)
		}
		return strings.ToLower(host + ":" + port)
	}
	return strings.ToLower(host)
}

// coalesceAddress returns a normalized address from server_address / http_host labels.
// Prefers server_address; falls back to http_host.
func coalesceAddress(serverAddress, httpHost string) string {
	if serverAddress != "" {
		return normalizeAddress(serverAddress)
	}
	return normalizeAddress(httpHost)
}

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
// GET /services/{namespace}/{service}/dependencies?from=&to=&environment=
func (a *App) handleServiceDependencies(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	service := queries.MustSanitizeLabel(req.PathValue("service"))
	namespace := queries.MustSanitizeLabel(req.PathValue("namespace"))
	filterEnv := queries.MustSanitizeLabel(req.URL.Query().Get("environment"))

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

	deps := a.queryDependencies(ctx, to, service, "", namespace, filterEnv)
	writeJSON(w, DependenciesResponse{Dependencies: deps})
}

// handleGlobalDependencies returns all external dependencies across all services.
// GET /dependencies?from=&to=&environment=
func (a *App) handleGlobalDependencies(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	filterEnv := queries.MustSanitizeLabel(req.URL.Query().Get("environment"))

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.ServiceGraph.Detected {
		writeJSON(w, DependenciesResponse{Dependencies: []DependencySummary{}})
		return
	}

	now := time.Now()
	to := parseUnixParam(req, "to", now)

	deps := a.queryDependencies(ctx, to, "", "", "", filterEnv)
	writeJSON(w, DependenciesResponse{Dependencies: deps})
}

// handleDependencyDetail returns RED metrics and upstream services for a specific dependency.
// GET /dependencies/{name}?from=&to=&environment=
func (a *App) handleDependencyDetail(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	depName := queries.MustSanitizeLabel(req.PathValue("name"))
	filterEnv := queries.MustSanitizeLabel(req.URL.Query().Get("environment"))

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

	detail := a.queryDependencyDetail(ctx, caps, to, depName, filterEnv)
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

// queryDependencies queries servicegraph metrics for dependencies,
// supplemented by spanmetrics for richer type information and to catch
// dependencies that the service graph connector may miss (e.g. external
// APIs identified by server_address / http_host).
// Note: environment filtering is applied to spanmetrics queries only.
// Service graph metrics may not carry the environment label depending
// on the collector pipeline configuration.
func (a *App) queryDependencies(
	ctx context.Context,
	to time.Time,
	filterClient string,
	filterServer string,
	_ string,
	filterEnvironment string,
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
	envFilterStr := ""
	if filterEnvironment != "" {
		envFilterStr = fmt.Sprintf(`, %s="%s"`, a.otelCfg.Labels.DeploymentEnv, filterEnvironment)
	}
	dbEnrichQuery := fmt.Sprintf(
		`count by (%s, %s) (rate(%s{%s!="", %s="%s"%s}%s))`,
		a.otelCfg.Labels.ServerAddress, a.otelCfg.Labels.DBSystem,
		a.callsMetric(ctx), a.otelCfg.Labels.DBSystem, a.otelCfg.Labels.SpanKind, a.otelCfg.SpanKinds.Client,
		envFilterStr,
		rangeStr,
	)

	// Spanmetrics supplement: discover downstream dependencies from CLIENT/CONSUMER
	// spans using server_address, http_host, db_system, messaging_system attributes.
	// This catches external APIs and dependencies that the service graph connector misses.
	smQueries := a.buildSpanmetricsDepsQueries(ctx, filterClient, filterEnvironment, rangeStr)

	type queryResult struct {
		name    string
		results []queries.PromResult
		err     error
	}

	var wg sync.WaitGroup

	allQueries := []struct {
		name  string
		query string
	}{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p95", p95Query},
		{"db_enrich", dbEnrichQuery},
	}
	for _, sq := range smQueries {
		allQueries = append(allQueries, struct {
			name  string
			query string
		}{sq.name, sq.query})
	}

	ch := make(chan queryResult, len(allQueries))
	for _, q := range allQueries {
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

	// Merge spanmetrics supplement: add dependencies discovered via CLIENT/CONSUMER spans
	// that weren't already found via service graph.
	sgNames := make(map[string]bool, len(deps))
	for k := range deps {
		sgNames[strings.ToLower(k.server)] = true
	}
	smDeps := a.mergeSpanmetricsDeps(resultMap, dbSystemMap, sgNames)
	for k, d := range smDeps {
		deps[k] = d
	}

	// Calculate total impact denominator
	totalImpact := 0.0
	for _, d := range deps {
		totalImpact += d.p95 * d.rate
	}

	// Build response — skip entries with empty or placeholder names,
	// and skip internal services (type "service") since they have their own overview page.
	result := make([]DependencySummary, 0, len(deps))
	for key, d := range deps {
		if key.server == "" || key.server == "unknown" || key.server == "<unknown>" {
			continue
		}
		depType := classifyDependency(key.server, key.connType, dbSystemMap)
		if depType == "service" {
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
			Type:         depType,
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

// spanmetricsQuery is a named query for the spanmetrics supplement.
type spanmetricsQuery struct {
	name  string
	query string
}

// buildSpanmetricsDepsQueries builds spanmetrics queries to supplement service graph
// dependency discovery. Returns rate and error queries using CLIENT/CONSUMER spans.
func (a *App) buildSpanmetricsDepsQueries(ctx context.Context, filterClient, filterEnvironment, rangeStr string) []spanmetricsQuery {
	cfg := a.otelCfg
	kindFilter := fmt.Sprintf(
		`%s=~"%s|%s|%s"`,
		cfg.Labels.SpanKind, cfg.SpanKinds.Client, cfg.SpanKinds.Consumer, cfg.SpanKinds.Producer,
	)

	// When scoped to a specific service, filter by service name.
	// When global (no filterClient), query all CLIENT/CONSUMER spans.
	serviceFilter := ""
	if filterClient != "" {
		serviceFilter = fmt.Sprintf(`, %s="%s"`, cfg.Labels.ServiceName, filterClient)
	}

	// Environment filter on spanmetrics (these carry k8s_cluster_name from resource_to_telemetry_conversion).
	envFilter := ""
	if filterEnvironment != "" {
		envFilter = fmt.Sprintf(`, %s="%s"`, cfg.Labels.DeploymentEnv, filterEnvironment)
	}

	// Rate by (server_address, http_host, db_system, messaging_system)
	smRateQ := fmt.Sprintf(
		`sum by (%s, %s, %s, %s) (rate(%s{%s%s%s}%s))`,
		cfg.Labels.ServerAddress, cfg.Labels.HTTPHost,
		cfg.Labels.DBSystem, cfg.Labels.MessagingSystem,
		a.callsMetric(ctx),
		kindFilter, serviceFilter, envFilter,
		rangeStr,
	)
	// Error rate
	smErrQ := fmt.Sprintf(
		`sum by (%s, %s, %s, %s) (rate(%s{%s%s%s, %s="%s"}%s))`,
		cfg.Labels.ServerAddress, cfg.Labels.HTTPHost,
		cfg.Labels.DBSystem, cfg.Labels.MessagingSystem,
		a.callsMetric(ctx),
		kindFilter, serviceFilter, envFilter,
		cfg.Labels.StatusCode, cfg.StatusCodes.Error,
		rangeStr,
	)

	return []spanmetricsQuery{
		{"sm_rate", smRateQ},
		{"sm_error", smErrQ},
	}
}

// mergeSpanmetricsDeps processes spanmetrics results and returns deps not already in service graph.
// sgNames contains lowercased names already discovered via service graph.
func (a *App) mergeSpanmetricsDeps(
	resultMap map[string][]queries.PromResult,
	dbSystemMap map[string]string,
	sgNames map[string]bool,
) map[depKey]*depData {
	cfg := a.otelCfg
	smRateResults := resultMap["sm_rate"]
	smErrResults := resultMap["sm_error"]
	if len(smRateResults) == 0 {
		return nil
	}

	type smDepData struct {
		rate     float64
		errRate  float64
		connType string
	}
	smDeps := make(map[string]*smDepData) // normalized address → data

	for _, r := range smRateResults {
		addr := coalesceAddress(
			r.Metric[cfg.Labels.ServerAddress],
			r.Metric[cfg.Labels.HTTPHost],
		)
		if addr == "" {
			continue
		}

		// Determine system type for classification
		connType := ""
		if dbSys := r.Metric[cfg.Labels.DBSystem]; dbSys != "" {
			connType = "database"
			dbSystemMap[addr] = dbSys
		} else if r.Metric[cfg.Labels.MessagingSystem] != "" {
			connType = "messaging_system"
		}

		d, ok := smDeps[addr]
		if !ok {
			d = &smDepData{connType: connType}
			smDeps[addr] = d
		}
		d.rate += r.Value.Float()
	}

	for _, r := range smErrResults {
		addr := coalesceAddress(
			r.Metric[cfg.Labels.ServerAddress],
			r.Metric[cfg.Labels.HTTPHost],
		)
		if addr == "" {
			continue
		}
		if d, ok := smDeps[addr]; ok {
			d.errRate += r.Value.Float()
		}
	}

	// Only add deps not already found via service graph
	result := make(map[depKey]*depData)
	for addr, sd := range smDeps {
		if sgNames[strings.ToLower(addr)] {
			continue
		}
		if addr == "" || addr == "unknown" || addr == "<unknown>" {
			continue
		}
		k := depKey{server: addr, connType: sd.connType}
		result[k] = &depData{
			rate:      sd.rate,
			errorRate: sd.errRate,
		}
	}
	return result
}

type depData struct {
	rate      float64
	errorRate float64
	p95       float64
}

// queryDependencyDetail returns RED metrics + upstream callers + operations for a dependency.
func (a *App) queryDependencyDetail(
	ctx context.Context,
	caps queries.Capabilities,
	to time.Time,
	depName string,
	filterEnvironment string,
) DependencyDetailResponse {
	logger := log.DefaultLogger.With("handler", "dependency-detail", "dep", depName)
	rangeStr := "[5m]"
	sgp := a.serviceGraphPrefix()
	cfg := a.otelCfg
	labelFilter := fmt.Sprintf(`%s="%s"`, cfg.Labels.Server, depName)

	// Query upstream services (by client) — service graph
	rateQuery := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s%s{%s}%s))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.ConnectionType,
		sgp, cfg.ServiceGraph.RequestTotal, labelFilter, rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s%s{%s}%s))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.ConnectionType,
		sgp, cfg.ServiceGraph.RequestFailedTotal, labelFilter, rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s) (rate(%s%s{%s}%s)))`,
		cfg.Labels.Client, cfg.Labels.Le,
		sgp, cfg.ServiceGraph.RequestServerBucket, labelFilter, rangeStr,
	)
	// Enrichment for specific DB type
	envFilter := ""
	if filterEnvironment != "" {
		envFilter = fmt.Sprintf(`, %s="%s"`, cfg.Labels.DeploymentEnv, filterEnvironment)
	}
	dbEnrichQuery := fmt.Sprintf(
		`count by (%s, %s) (rate(%s{%s="%s", %s!="", %s="%s"%s}%s))`,
		cfg.Labels.ServerAddress, cfg.Labels.DBSystem,
		a.callsMetric(ctx),
		cfg.Labels.ServerAddress, depName,
		cfg.Labels.DBSystem,
		cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		envFilter,
		rangeStr,
	)

	// Spanmetrics supplement: find upstream callers that target this dependency
	// via server_address or http_host. This catches external API callers that
	// the service graph connector may not see.
	smUpRateQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s{%s="%s", %s="%s"%s}%s)) or sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s(:%s)?"%s}%s))`,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.ServerAddress, depName, envFilter, rangeStr,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.HTTPHost, depName, "443", envFilter, rangeStr,
	)
	smUpErrQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s{%s="%s", %s="%s", %s="%s"%s}%s)) or sum by (%s, %s) (rate(%s{%s="%s", %s="%s", %s=~"%s(:%s)?"%s}%s))`,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.StatusCode, cfg.StatusCodes.Error,
		cfg.Labels.ServerAddress, depName, envFilter, rangeStr,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.StatusCode, cfg.StatusCodes.Error,
		cfg.Labels.HTTPHost, depName, "443", envFilter, rangeStr,
	)

	type queryResult struct {
		name    string
		results []queries.PromResult
		err     error
	}

	var wg sync.WaitGroup
	allQueries := []struct {
		name  string
		query string
	}{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p95", p95Query},
		{"db_enrich", dbEnrichQuery},
		{"smUpRate", smUpRateQ},
		{"smUpErr", smUpErrQ},
	}
	ch := make(chan queryResult, len(allQueries))

	for _, q := range allQueries {
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

	// Merge spanmetrics upstream callers (services that call this dependency
	// via server_address / http_host)
	for _, r := range resultMap["smUpRate"] {
		svc := r.Metric[cfg.Labels.ServiceName]
		if svc == "" {
			continue
		}
		u, ok := upstreams[svc]
		if !ok {
			u = &upstreamData{}
			upstreams[svc] = u
		}
		v := r.Value.Float()
		u.rate += v
		totalRate += v
	}
	for _, r := range resultMap["smUpErr"] {
		svc := r.Metric[cfg.Labels.ServiceName]
		if svc == "" {
			continue
		}
		if u, ok := upstreams[svc]; ok {
			v := r.Value.Float()
			u.errorRate += v
			totalError += v
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
	operations := a.queryDependencyOperations(ctx, caps, to, depName, filterEnvironment)

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
// Tries peer_service first, then falls back to server_address / http_host.
func (a *App) queryDependencyOperations(
	ctx context.Context,
	caps queries.Capabilities,
	to time.Time,
	depName string,
	filterEnvironment string,
) []queries.DependencyOperation {
	logger := log.DefaultLogger.With("handler", "dependency-operations", "dep", depName)
	cfg := a.otelCfg
	callsMetric := caps.SpanMetrics.CallsMetric
	durationUnit := caps.SpanMetrics.DurationUnit
	durationBucket := caps.SpanMetrics.DurationMetric

	rangeStr := "[5m]"

	envFilter := ""
	if filterEnvironment != "" {
		envFilter = fmt.Sprintf(`, %s="%s"`, cfg.Labels.DeploymentEnv, filterEnvironment)
	}

	// Primary filter: peer_service (from spanmetrics connector dimensions)
	peerFilter := fmt.Sprintf(`peer_service="%s", %s="%s"%s`, depName, cfg.Labels.SpanKind, cfg.SpanKinds.Client, envFilter)
	// Fallback filter: server_address (from span attributes promoted to metrics)
	addrFilter := fmt.Sprintf(`%s="%s", %s="%s"%s`, cfg.Labels.ServerAddress, depName, cfg.Labels.SpanKind, cfg.SpanKinds.Client, envFilter)
	// Second fallback: http_host with optional :443 suffix
	hostFilter := fmt.Sprintf(`%s=~"%s(:443)?", %s="%s"%s`, cfg.Labels.HTTPHost, depName, cfg.Labels.SpanKind, cfg.SpanKinds.Client, envFilter)

	// Build queries using OR across all three filter strategies
	rateQuery := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s{%s}%s)) or sum by (%s, %s) (rate(%s{%s}%s)) or sum by (%s, %s) (rate(%s{%s}%s))`,
		cfg.Labels.SpanName, cfg.Labels.ServiceName,
		callsMetric, peerFilter, rangeStr,
		cfg.Labels.SpanName, cfg.Labels.ServiceName,
		callsMetric, addrFilter, rangeStr,
		cfg.Labels.SpanName, cfg.Labels.ServiceName,
		callsMetric, hostFilter, rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s{%s, %s="%s"}%s)) or sum by (%s, %s) (rate(%s{%s, %s="%s"}%s)) or sum by (%s, %s) (rate(%s{%s, %s="%s"}%s))`,
		cfg.Labels.SpanName, cfg.Labels.ServiceName,
		callsMetric, peerFilter, cfg.Labels.StatusCode, cfg.StatusCodes.Error, rangeStr,
		cfg.Labels.SpanName, cfg.Labels.ServiceName,
		callsMetric, addrFilter, cfg.Labels.StatusCode, cfg.StatusCodes.Error, rangeStr,
		cfg.Labels.SpanName, cfg.Labels.ServiceName,
		callsMetric, hostFilter, cfg.Labels.StatusCode, cfg.StatusCodes.Error, rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s{%s}%s))) or histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s{%s}%s))) or histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s{%s}%s)))`,
		cfg.Labels.SpanName, cfg.Labels.ServiceName, cfg.Labels.Le,
		durationBucket, peerFilter, rangeStr,
		cfg.Labels.SpanName, cfg.Labels.ServiceName, cfg.Labels.Le,
		durationBucket, addrFilter, rangeStr,
		cfg.Labels.SpanName, cfg.Labels.ServiceName, cfg.Labels.Le,
		durationBucket, hostFilter, rangeStr,
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
	case looksLikeHostname(lower):
		return "external"
	default:
		return "service"
	}
}

// looksLikeHostname returns true if the name contains dots or colons (host:port),
// indicating an external hostname rather than an internal service name.
func looksLikeHostname(name string) bool {
	return strings.Contains(name, ".") || strings.Contains(name, ":")
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
	ctx := a.requestContext(req)
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
	cfg := a.otelCfg

	// Outbound: where service is the client
	// Include connection_type to distinguish database, messaging, and service connections.
	outRateQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s%s{%s="%s"}%s))`,
		cfg.Labels.Server, cfg.Labels.ConnectionType,
		sgp, cfg.ServiceGraph.RequestTotal,
		cfg.Labels.Client, service, rangeStr,
	)
	outErrQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s%s{%s="%s"}%s))`,
		cfg.Labels.Server, cfg.Labels.ConnectionType,
		sgp, cfg.ServiceGraph.RequestFailedTotal,
		cfg.Labels.Client, service, rangeStr,
	)
	outP95Q := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s%s{%s="%s"}%s)))`,
		cfg.Labels.Server, cfg.Labels.ConnectionType, cfg.Labels.Le,
		sgp, cfg.ServiceGraph.RequestServerBucket,
		cfg.Labels.Client, service, rangeStr,
	)

	// Inbound: where service is the server (service graph)
	inRateQ := fmt.Sprintf(
		`sum by (%s) (rate(%s%s{%s="%s"}%s))`,
		cfg.Labels.Client,
		sgp, cfg.ServiceGraph.RequestTotal,
		cfg.Labels.Server, service, rangeStr,
	)
	inErrQ := fmt.Sprintf(
		`sum by (%s) (rate(%s%s{%s="%s"}%s))`,
		cfg.Labels.Client,
		sgp, cfg.ServiceGraph.RequestFailedTotal,
		cfg.Labels.Server, service, rangeStr,
	)
	inP95Q := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s) (rate(%s%s{%s="%s"}%s)))`,
		cfg.Labels.Client, cfg.Labels.Le,
		sgp, cfg.ServiceGraph.RequestServerBucket,
		cfg.Labels.Server, service, rangeStr,
	)

	// Spanmetrics supplement: find upstream callers via CLIENT spans whose
	// server_address or http_host matches this service name.
	// Pattern: server_address=~"appname[.:].*" catches both
	// "appname.namespace.svc" and "appname:8080" style addresses.
	escapedSvc := regexp.QuoteMeta(service) // proper regex escaping (dots, etc.)
	smInRateQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s[.:].*"}%s)) or sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s[.:].*"}%s))`,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.ServerAddress, escapedSvc, rangeStr,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.HTTPHost, escapedSvc, rangeStr,
	)
	smInErrQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s{%s="%s", %s="%s", %s=~"%s[.:].*"}%s)) or sum by (%s, %s) (rate(%s{%s="%s", %s="%s", %s=~"%s[.:].*"}%s))`,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.StatusCode, cfg.StatusCodes.Error,
		cfg.Labels.ServerAddress, escapedSvc, rangeStr,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.StatusCode, cfg.StatusCodes.Error,
		cfg.Labels.HTTPHost, escapedSvc, rangeStr,
	)

	type queryResult struct {
		name    string
		results []queries.PromResult
		err     error
	}

	var wg sync.WaitGroup
	allQueries := []struct {
		name  string
		query string
	}{
		{"outRate", outRateQ}, {"outErr", outErrQ}, {"outP95", outP95Q},
		{"inRate", inRateQ}, {"inErr", inErrQ}, {"inP95", inP95Q},
		{"smInRate", smInRateQ}, {"smInErr", smInErrQ},
	}
	ch := make(chan queryResult, len(allQueries))

	for _, q := range allQueries {
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
			k := connKey{name: name, connectionType: r.Metric[cfg.Labels.ConnectionType]}
			d, ok := m[k]
			if !ok {
				d = &svcData{}
				m[k] = d
			}
			d.rate += r.Value.Float()
		}
		for _, r := range resultMap[errKey] {
			name := r.Metric[peerLabel]
			ct := r.Metric[cfg.Labels.ConnectionType]
			k := connKey{name: name, connectionType: ct}
			if d, ok := m[k]; ok {
				d.err += r.Value.Float()
			}
		}
		if p95Key != "" {
			for _, r := range resultMap[p95Key] {
				name := r.Metric[peerLabel]
				ct := r.Metric[cfg.Labels.ConnectionType]
				k := connKey{name: name, connectionType: ct}
				if d, ok := m[k]; ok {
					v := r.Value.Float()
					if !math.IsNaN(v) && !math.IsInf(v, 0) {
						d.p95 = v
					}
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

	outbound := buildList("outRate", "outErr", "outP95", cfg.Labels.Server)
	inbound := buildList("inRate", "inErr", "inP95", cfg.Labels.Client)

	// Merge spanmetrics inbound callers (discovered via server_address/http_host matching)
	smInbound := buildList("smInRate", "smInErr", "", cfg.Labels.ServiceName)
	inboundNames := make(map[string]bool, len(inbound))
	for _, s := range inbound {
		inboundNames[strings.ToLower(s.Name)] = true
	}
	for _, s := range smInbound {
		if s.Name == service || inboundNames[strings.ToLower(s.Name)] {
			continue // already in service graph results or self-reference
		}
		inbound = append(inbound, s)
	}
	// Re-sort merged inbound by rate
	sort.Slice(inbound, func(i, j int) bool {
		return inbound[i].Rate > inbound[j].Rate
	})

	if outbound == nil {
		outbound = []ConnectedService{}
	}
	if inbound == nil {
		inbound = []ConnectedService{}
	}

	return ConnectedServicesResponse{Inbound: inbound, Outbound: outbound}
}
