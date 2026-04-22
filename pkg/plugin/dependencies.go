package plugin

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// addressMatchRegex returns a PromQL regex pattern that matches both the
// normalized address form (as shown in the UI) and the raw metric label value.
// e.g., "idporten.no" → `idporten\.no(:(443|80))?` (matches idporten.no, idporten.no:443, idporten.no:80)
// e.g., "db:5432" → `db:5432` (non-standard port, exact match)
func addressMatchRegex(normalized string) string {
	host, port, hasPort := strings.Cut(normalized, ":")
	escaped := regexp.QuoteMeta(host)
	if hasPort {
		// Name retains a non-standard port → exact match
		return escaped + ":" + regexp.QuoteMeta(port)
	}
	// Name was normalized (standard port stripped) → match with optional :443 or :80
	return escaped + "(:(443|80))?"
}

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

// DependencySummary, DependenciesResponse → models.go

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

// DependencyDetailResponse → models.go

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

	allJobs := []QueryJob{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p95", p95Query},
		{"db_enrich", dbEnrichQuery},
	}
	for _, sq := range smQueries {
		allJobs = append(allJobs, QueryJob{sq.name, sq.query})
	}

	resultMap := a.runInstantQueries(ctx, to, allJobs, logger)

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
			if isValidMetricValue(v) {
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
		errPct := calculateErrorRate(d.errorRate, d.rate)
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

	// Rate by (server_address, http_host, db_system, messaging_system, messaging_destination_name)
	smRateQ := fmt.Sprintf(
		`sum by (%s, %s, %s, %s, %s) (rate(%s{%s%s%s}%s))`,
		cfg.Labels.ServerAddress, cfg.Labels.HTTPHost,
		cfg.Labels.DBSystem, cfg.Labels.MessagingSystem, cfg.Labels.MessagingDestination,
		a.callsMetric(ctx),
		kindFilter, serviceFilter, envFilter,
		rangeStr,
	)
	// Error rate
	smErrQ := fmt.Sprintf(
		`sum by (%s, %s, %s, %s, %s) (rate(%s{%s%s%s, %s="%s"}%s))`,
		cfg.Labels.ServerAddress, cfg.Labels.HTTPHost,
		cfg.Labels.DBSystem, cfg.Labels.MessagingSystem, cfg.Labels.MessagingDestination,
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
		`count by (%s, %s) (rate(%s{%s=~"%s", %s!="", %s="%s"%s}%s))`,
		cfg.Labels.ServerAddress, cfg.Labels.DBSystem,
		a.callsMetric(ctx),
		cfg.Labels.ServerAddress, addressMatchRegex(depName),
		cfg.Labels.DBSystem,
		cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		envFilter,
		rangeStr,
	)

	// Spanmetrics supplement: find upstream callers that target this dependency
	// via server_address or http_host. Uses regex matching to handle address
	// normalization (e.g., "idporten.no" must match "idporten.no:443" in labels).
	addrRegex := addressMatchRegex(depName)
	smKindFilter := fmt.Sprintf(`%s="%s"`, cfg.Labels.SpanKind, cfg.SpanKinds.Client)
	smAddrMatch := fmt.Sprintf(`%s=~"%s"`, cfg.Labels.ServerAddress, addrRegex)
	smHostMatch := fmt.Sprintf(`%s=~"%s"`, cfg.Labels.HTTPHost, addrRegex)

	smUpRateQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s{%s, %s%s}%s)) or sum by (%s, %s) (rate(%s{%s, %s%s}%s))`,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), smKindFilter, smAddrMatch, envFilter, rangeStr,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), smKindFilter, smHostMatch, envFilter, rangeStr,
	)
	smUpErrQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s{%s, %s="%s", %s%s}%s)) or sum by (%s, %s) (rate(%s{%s, %s="%s", %s%s}%s))`,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), smKindFilter, cfg.Labels.StatusCode, cfg.StatusCodes.Error, smAddrMatch, envFilter, rangeStr,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), smKindFilter, cfg.Labels.StatusCode, cfg.StatusCodes.Error, smHostMatch, envFilter, rangeStr,
	)
	// Spanmetric P95 for dependencies not in service graph (external APIs, etc.)
	durationBucket := caps.SpanMetrics.DurationMetric
	smUpP95Q := ""
	if durationBucket != "" {
		smUpP95Q = fmt.Sprintf(
			`histogram_quantile(0.95, sum by (%s) (rate(%s{%s, %s%s}%s))) or histogram_quantile(0.95, sum by (%s) (rate(%s{%s, %s%s}%s)))`,
			cfg.Labels.Le,
			durationBucket, smKindFilter, smAddrMatch, envFilter, rangeStr,
			cfg.Labels.Le,
			durationBucket, smKindFilter, smHostMatch, envFilter, rangeStr,
		)
	}

	jobs := []QueryJob{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p95", p95Query},
		{"db_enrich", dbEnrichQuery},
		{"smUpRate", smUpRateQ},
		{"smUpErr", smUpErrQ},
	}
	if smUpP95Q != "" {
		jobs = append(jobs, QueryJob{"smUpP95", smUpP95Q})
	}
	resultMap := a.runInstantQueries(ctx, to, jobs, logger)

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

	upstreamList, totalRate, totalError, totalP95 := a.aggregateUpstreams(resultMap, caps)

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

// upstreamData tracks metrics for a single upstream caller.
type upstreamData struct {
	rate      float64
	errorRate float64
	p95       float64
	fromSG    bool // present in service graph results (for dedup)
}

// aggregateUpstreams merges service graph and spanmetric upstream callers,
// deduplicating services present in both sources. Returns the upstream list
// and aggregate totals (rate, error, p95).
func (a *App) aggregateUpstreams(
	resultMap map[string][]queries.PromResult,
	caps queries.Capabilities,
) ([]DependencySummary, float64, float64, float64) {
	cfg := a.otelCfg
	upstreams := make(map[string]*upstreamData)
	totalRate := 0.0
	totalError := 0.0
	totalP95 := 0.0

	// Service graph: aggregate by client label
	for _, r := range resultMap["rate"] {
		client := r.Metric[cfg.Labels.Client]
		if client == "" {
			continue
		}
		u, ok := upstreams[client]
		if !ok {
			u = &upstreamData{fromSG: true}
			upstreams[client] = u
		}
		v := r.Value.Float()
		u.rate += v
		totalRate += v
	}
	for _, r := range resultMap["error"] {
		client := r.Metric[cfg.Labels.Client]
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
		client := r.Metric[cfg.Labels.Client]
		if client == "" {
			continue
		}
		if u, ok := upstreams[client]; ok {
			v := r.Value.Float()
			if isValidMetricValue(v) {
				u.p95 = v
				if v > totalP95 {
					totalP95 = v
				}
			}
		}
	}

	// Spanmetrics: merge upstream callers, skip services already in service graph
	for _, r := range resultMap["smUpRate"] {
		svc := r.Metric[cfg.Labels.ServiceName]
		if svc == "" {
			continue
		}
		if u, ok := upstreams[svc]; ok && u.fromSG {
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
		if u, ok := upstreams[svc]; ok && u.fromSG {
			continue
		}
		if u, ok := upstreams[svc]; ok {
			v := r.Value.Float()
			u.errorRate += v
			totalError += v
		}
	}

	// Use spanmetric P95 when service graph P95 is absent
	if totalP95 == 0 {
		if smP95Results, ok := resultMap["smUpP95"]; ok {
			for _, r := range smP95Results {
				v := r.Value.Float()
				if isValidMetricValue(v) && v > totalP95 {
					if caps.SpanMetrics.DurationUnit == "ms" {
						totalP95 = v / 1000
					} else {
						totalP95 = v
					}
				}
			}
		}
	}

	// Build sorted list with impact scores
	totalImpact := 0.0
	for _, u := range upstreams {
		totalImpact += u.p95 * u.rate
	}

	list := make([]DependencySummary, 0, len(upstreams))
	for name, u := range upstreams {
		errPct := calculateErrorRate(u.errorRate, u.rate)
		impact := 0.0
		if totalImpact > 0 {
			impact = (u.p95 * u.rate) / totalImpact
		}
		list = append(list, DependencySummary{
			Name:         name,
			Type:         "service",
			Rate:         roundTo(u.rate, 3),
			ErrorRate:    roundTo(errPct, 2),
			P95Duration:  roundTo(u.p95*1000, 2),
			DurationUnit: "ms",
			Impact:       roundTo(impact, 4),
		})
	}
	return list, totalRate, totalError, totalP95
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
	// Fallback filter: server_address with regex to match normalized addresses
	addrRegex := addressMatchRegex(depName)
	addrFilter := fmt.Sprintf(`%s=~"%s", %s="%s"%s`, cfg.Labels.ServerAddress, addrRegex, cfg.Labels.SpanKind, cfg.SpanKinds.Client, envFilter)
	// Second fallback: http_host with same regex
	hostFilter := fmt.Sprintf(`%s=~"%s", %s="%s"%s`, cfg.Labels.HTTPHost, addrRegex, cfg.Labels.SpanKind, cfg.SpanKinds.Client, envFilter)

	// Build queries using OR across all three filter strategies.
	// Include db_name, db_operation, messaging_destination_name in grouping
	// so operations show per-database and per-topic detail when available.
	byLabels := fmt.Sprintf("%s, %s, %s, %s, %s",
		cfg.Labels.SpanName, cfg.Labels.ServiceName,
		cfg.Labels.DBName, cfg.Labels.DBOperation, cfg.Labels.MessagingDestination,
	)
	byLabelsLe := fmt.Sprintf("%s, %s, %s, %s, %s, %s",
		cfg.Labels.SpanName, cfg.Labels.ServiceName,
		cfg.Labels.DBName, cfg.Labels.DBOperation, cfg.Labels.MessagingDestination,
		cfg.Labels.Le,
	)
	rateQuery := fmt.Sprintf(
		`sum by (%s) (rate(%s{%s}%s)) or sum by (%s) (rate(%s{%s}%s)) or sum by (%s) (rate(%s{%s}%s))`,
		byLabels, callsMetric, peerFilter, rangeStr,
		byLabels, callsMetric, addrFilter, rangeStr,
		byLabels, callsMetric, hostFilter, rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (%s) (rate(%s{%s, %s="%s"}%s)) or sum by (%s) (rate(%s{%s, %s="%s"}%s)) or sum by (%s) (rate(%s{%s, %s="%s"}%s))`,
		byLabels, callsMetric, peerFilter, cfg.Labels.StatusCode, cfg.StatusCodes.Error, rangeStr,
		byLabels, callsMetric, addrFilter, cfg.Labels.StatusCode, cfg.StatusCodes.Error, rangeStr,
		byLabels, callsMetric, hostFilter, cfg.Labels.StatusCode, cfg.StatusCodes.Error, rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s) (rate(%s{%s}%s))) or histogram_quantile(0.95, sum by (%s) (rate(%s{%s}%s))) or histogram_quantile(0.95, sum by (%s) (rate(%s{%s}%s)))`,
		byLabelsLe, durationBucket, peerFilter, rangeStr,
		byLabelsLe, durationBucket, addrFilter, rangeStr,
		byLabelsLe, durationBucket, hostFilter, rangeStr,
	)

	resultMap := a.runInstantQueries(ctx, to, []QueryJob{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p95", p95Query},
	}, logger)

	type opKey struct {
		spanName    string
		serviceName string
		dbName      string
		dbOperation string
		msgDest     string
	}
	opsMap := make(map[opKey]*queries.DependencyOperation)
	getOrCreate := func(r queries.PromResult) *queries.DependencyOperation {
		k := opKey{
			spanName:    r.Metric[a.otelCfg.Labels.SpanName],
			serviceName: r.Metric[a.otelCfg.Labels.ServiceName],
			dbName:      r.Metric[a.otelCfg.Labels.DBName],
			dbOperation: r.Metric[a.otelCfg.Labels.DBOperation],
			msgDest:     r.Metric[a.otelCfg.Labels.MessagingDestination],
		}
		if o, ok := opsMap[k]; ok {
			return o
		}
		o := &queries.DependencyOperation{
			SpanName:             k.spanName,
			CallingService:       k.serviceName,
			DbName:               k.dbName,
			DbOperation:          k.dbOperation,
			MessagingDestination: k.msgDest,
			DurationUnit:         durationUnit,
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
		o.ErrorRate = calculateErrorRate(r.Value.Float(), o.Rate)
	}
	for _, r := range resultMap["p95"] {
		o := getOrCreate(r)
		v := r.Value.Float()
		if isValidMetricValue(v) {
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

// ConnectedService, ConnectedServicesResponse → models.go

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
					if isValidMetricValue(v) {
						d.p95 = v
					}
				}
			}
		}
		result := make([]ConnectedService, 0, len(m))
		for k, d := range m {
			result = append(result, ConnectedService{
				Name:           k.name,
				ConnectionType: k.connectionType,
				IsSidecar:      isSidecar(k.name),
				Rate:           roundTo(d.rate, 3),
				ErrorRate:      calculateErrorRate(d.err, d.rate),
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

	return ConnectedServicesResponse{Inbound: inbound, Outbound: outbound}
}
