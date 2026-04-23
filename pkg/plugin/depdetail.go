package plugin

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

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
	labelFilter := fmt.Sprintf(`%s=~"%s"`, cfg.Labels.Server, addressMatchRegex(depName))
	if filterEnvironment != "" {
		labelFilter += fmt.Sprintf(`, %s="%s"`, cfg.Labels.DeploymentEnv, filterEnvironment)
	}

	// Query upstream services (by client) — service graph.
	// Include db_system and messaging_system for classification and display.
	rateQuery := fmt.Sprintf(
		`sum by (%s, %s, %s, %s, %s) (rate(%s%s{%s}%s))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.ConnectionType,
		cfg.Labels.DBSystem, cfg.Labels.MessagingSystem,
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
	// Spanmetrics supplement: find upstream callers that target this dependency
	// via server_address or http_host. Uses regex matching to handle address
	// normalization (e.g., "idporten.no" must match "idporten.no:443" in labels).
	addrRegex := addressMatchRegex(depName)
	envFilter := ""
	if filterEnvironment != "" {
		envFilter = fmt.Sprintf(`, %s="%s"`, cfg.Labels.DeploymentEnv, filterEnvironment)
	}
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
		{"smUpRate", smUpRateQ},
		{"smUpErr", smUpErrQ},
	}
	if smUpP95Q != "" {
		jobs = append(jobs, QueryJob{"smUpP95", smUpP95Q})
	}
	resultMap := a.runInstantQueries(ctx, to, jobs, logger)

	// Build classification maps from service graph rate results.
	// db_system and messaging_system are now available directly on SG metrics.
	dbSystemMap := make(map[string]string)
	messagingSystemMap := make(map[string]string)
	detectedConnType := ""
	for _, r := range resultMap["rate"] {
		if ct := r.Metric[a.otelCfg.Labels.ConnectionType]; ct != "" {
			detectedConnType = ct
		}
		if ds := r.Metric[a.otelCfg.Labels.DBSystem]; ds != "" {
			dbSystemMap[depName] = ds
		}
		if ms := r.Metric[a.otelCfg.Labels.MessagingSystem]; ms != "" {
			messagingSystemMap[depName] = ms
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
			DisplayName:  formatDepDisplayName(depName, dbSystemMap[depName], messagingSystemMap[depName]),
			Type:         classifyDependency(depName, detectedConnType, dbSystemMap, messagingSystemMap),
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
