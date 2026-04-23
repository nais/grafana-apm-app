package plugin

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// handleServiceDependencies returns downstream dependencies for a specific service.
// GET /services/{namespace}/{service}/dependencies?from=&to=&environment=
func (a *App) handleServiceDependencies(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	namespace, service := parseServiceRef(req)
	filterEnv := parseEnvironment(req)

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
	filterEnv := parseEnvironment(req)

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

// handleNamespaceDependencies returns external dependencies for all services in a namespace.
// Uses the service graph edges filtered by namespace to provide callerCount and proper RED metrics.
// GET /namespaces/{namespace}/dependencies?from=&to=&environment=
func (a *App) handleNamespaceDependencies(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	namespace := queries.MustSanitizeLabel(req.PathValue("namespace"))
	filterEnv := parseEnvironment(req)

	if namespace == "" {
		http.Error(w, `{"error":"missing or invalid namespace"}`, http.StatusBadRequest)
		return
	}

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.ServiceGraph.Detected {
		writeJSON(w, NamespaceDependenciesResponse{Dependencies: []NamespaceDependency{}})
		return
	}

	now := time.Now()
	to := parseUnixParam(req, "to", now)

	deps := a.queryNamespaceDependencies(ctx, to, namespace, filterEnv)
	writeJSON(w, NamespaceDependenciesResponse{Dependencies: deps})
}

// queryNamespaceDependencies finds external dependencies for a namespace by:
// 1. Building a service→namespace map from spanmetrics
// 2. Querying all service graph edges (with db_system/messaging_system labels)
// 3. Filtering to outbound edges from namespace services to non-namespace targets
// 4. Aggregating per-target with callerCount
func (a *App) queryNamespaceDependencies(
	ctx context.Context,
	to time.Time,
	namespace, filterEnv string,
) []NamespaceDependency {
	nsMap := a.buildServiceNamespaceMap(ctx, to, filterEnv)

	// Collect services belonging to this namespace
	nsServices := make(map[string]bool)
	for svc, ns := range nsMap {
		if ns == namespace {
			nsServices[svc] = true
		}
	}
	if len(nsServices) == 0 {
		return []NamespaceDependency{}
	}

	edges := a.queryServiceGraphEdges(ctx, to, filterEnv)

	// Build db_system and messaging_system maps from edge-level labels.
	// Service graph metrics now carry these directly — no spanmetrics cross-fetch needed.
	dbSystemMap := make(map[string]string)
	messagingSystemMap := make(map[string]string)
	for k, e := range edges {
		if e.dbSystem != "" {
			dbSystemMap[k.server] = e.dbSystem
		}
		if e.messagingSystem != "" {
			messagingSystemMap[k.server] = e.messagingSystem
		}
	}

	// Aggregate outbound edges: client in namespace, server NOT in namespace
	type depAgg struct {
		callers  map[string]bool
		rate     float64
		errRate  float64
		p95      float64
		connType string
	}
	deps := make(map[string]*depAgg)

	for k, e := range edges {
		if !nsServices[k.client] {
			continue
		}
		if nsServices[k.server] {
			continue
		}

		d, ok := deps[k.server]
		if !ok {
			d = &depAgg{callers: make(map[string]bool)}
			deps[k.server] = d
		}
		d.callers[k.client] = true
		d.rate += e.rate
		d.errRate += e.errorRate
		if e.p95 > d.p95 {
			d.p95 = e.p95
		}
		if d.connType == "" && e.connType != "" {
			d.connType = e.connType
		}
	}

	result := make([]NamespaceDependency, 0, len(deps))
	for name, d := range deps {
		if name == "" || name == "unknown" || name == "<unknown>" {
			continue
		}
		depType := classifyDependency(name, d.connType, dbSystemMap, messagingSystemMap)
		if depType == "service" {
			continue
		}
		errPct := calculateErrorRate(d.errRate, d.rate)
		result = append(result, NamespaceDependency{
			Name:         name,
			DisplayName:  formatDepDisplayName(name, dbSystemMap[name], messagingSystemMap[name]),
			Type:         depType,
			CallerCount:  len(d.callers),
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

// handleDependencyDetail returns RED metrics and upstream services for a specific dependency.
// GET /dependencies/{name}?from=&to=&environment=
func (a *App) handleDependencyDetail(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	depName := queries.MustSanitizeLabel(req.PathValue("name"))
	filterEnv := parseEnvironment(req)

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

// queryDependencies queries servicegraph metrics for dependencies,
// supplemented by spanmetrics for richer type information and to catch
// dependencies that the service graph connector may miss (e.g. external
// APIs identified by server_address / http_host).
// Note: environment filtering is applied to both service graph and
// spanmetrics queries. Service graph metrics carry the environment label
// as an external label from Mimir (set per-cluster by the collector).
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
	if filterEnvironment != "" {
		filters = append(filters, fmt.Sprintf(`%s="%s"`, a.otelCfg.Labels.DeploymentEnv, filterEnvironment))
	}

	labelFilter := ""
	for i, f := range filters {
		if i > 0 {
			labelFilter += ", "
		}
		labelFilter += f
	}

	// Include connection_type, db_system, and messaging_system in group-by.
	// These labels are available directly on service graph metrics, so no
	// separate spanmetrics enrichment query is needed for type classification.
	rateQuery := fmt.Sprintf(
		`sum by (%s, %s, %s, %s, %s) (rate(%s%s{%s}%s))`,
		a.otelCfg.Labels.Client, a.otelCfg.Labels.Server, ct,
		a.otelCfg.Labels.DBSystem, a.otelCfg.Labels.MessagingSystem,
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

	// Spanmetrics supplement: discover downstream dependencies from CLIENT/CONSUMER
	// spans using server_address, http_host, db_system, messaging_system attributes.
	// This catches external APIs and dependencies that the service graph connector misses.
	smQueries := a.buildSpanmetricsDepsQueries(ctx, filterClient, filterEnvironment, rangeStr)

	allJobs := []QueryJob{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p95", p95Query},
	}
	for _, sq := range smQueries {
		allJobs = append(allJobs, QueryJob{sq.name, sq.query})
	}

	resultMap := a.runInstantQueries(ctx, to, allJobs, logger)

	// Build db_system and messaging_system maps from service graph rate results.
	// These labels are now available directly on service graph metrics.
	dbSystemMap := make(map[string]string)
	messagingSystemMap := make(map[string]string)

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

		if ds := r.Metric[a.otelCfg.Labels.DBSystem]; ds != "" {
			dbSystemMap[server] = ds
		}
		if ms := r.Metric[a.otelCfg.Labels.MessagingSystem]; ms != "" {
			messagingSystemMap[server] = ms
		}
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
	smDeps := a.mergeSpanmetricsDeps(resultMap, dbSystemMap, messagingSystemMap, sgNames)
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
		depType := classifyDependency(key.server, key.connType, dbSystemMap, messagingSystemMap)
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
			DisplayName:  formatDepDisplayName(key.server, dbSystemMap[key.server], messagingSystemMap[key.server]),
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
	messagingSystemMap map[string]string,
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
		} else if msgSys := r.Metric[cfg.Labels.MessagingSystem]; msgSys != "" {
			connType = "messaging_system"
			messagingSystemMap[addr] = msgSys
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
