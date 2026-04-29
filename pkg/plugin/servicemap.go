package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// ServiceMapNode, ServiceMapEdge, ServiceMapResponse → models.go

func (a *App) handleServiceMap(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.ServiceGraph.Detected {
		writeJSON(w, ServiceMapResponse{Nodes: []ServiceMapNode{}, Edges: []ServiceMapEdge{}})
		return
	}

	now := time.Now()
	from := parseUnixParam(req, "from", now.Add(-1*time.Hour))
	to := parseUnixParam(req, "to", now)

	// Optional: filter to a specific service's neighborhood
	filterService := queries.MustSanitizeLabel(req.URL.Query().Get("service"))
	filterNamespace := queries.MustSanitizeLabel(req.URL.Query().Get("namespace"))
	filterEnvironment := parseEnvironment(req)

	// Depth: how many hops to explore (1 = direct neighbors, max 3)
	depth := 1
	if d, err := strconv.Atoi(req.URL.Query().Get("depth")); err == nil && d >= 1 && d <= 3 {
		depth = d
	}

	// Check response cache
	roundedFrom := fmt.Sprintf("%d", from.Unix()/30*30)
	roundedTo := fmt.Sprintf("%d", to.Unix()/30*30)
	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("servicemap", orgID, roundedFrom, roundedTo, filterService, filterNamespace, filterEnvironment, fmt.Sprintf("d%d", depth))
	if cached, ok := a.respCache.get(ck); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Cache", "HIT")
		_, _ = w.Write(cached)
		return
	}

	var graph ServiceMapResponse
	if depth > 1 && filterService != "" {
		graph = a.queryServiceMapMultiHop(ctx, from, to, filterService, filterNamespace, filterEnvironment, depth)
	} else {
		graph = a.queryServiceMap(ctx, from, to, filterService, filterNamespace, filterEnvironment)
	}

	a.respCache.setJSON(ck, graph)
	writeJSON(w, graph)
}

// computeRangeStr derives a PromQL range duration from the dashboard time window.
// It uses a floor of 5m (need enough samples for rate()) and a ceiling of 1h
// (avoid over-smoothing). This ensures infrequent callers are visible when the
// user has a wider dashboard time range.
func computeRangeStr(from, to time.Time) string {
	d := to.Sub(from)
	switch {
	case d <= 5*time.Minute:
		return "[5m]"
	case d <= 15*time.Minute:
		return "[10m]"
	case d <= 30*time.Minute:
		return "[15m]"
	case d <= time.Hour:
		return "[30m]"
	default:
		return "[1h]"
	}
}

// sgEdgeKey identifies a directed edge in the service graph.
type sgEdgeKey struct {
	client string
	server string
}

// sgEdgeData holds numeric metrics for a service graph edge.
type sgEdgeData struct {
	rate            float64
	errorRate       float64
	p95             float64
	connType        string
	dbSystem        string
	messagingSystem string
}

// queryServiceGraphEdges runs the 3 service graph queries (rate, error, P95)
// and returns raw edge data. This is the shared building block for both
// the service map endpoint and namespace dependencies.
//
// filterService optionally scopes the PromQL to edges where the service
// appears as either client or server. For large environments this is
// critical — an unscoped query can time out when there are thousands
// of service-to-service edges. When empty, all edges are returned.
func (a *App) queryServiceGraphEdges(ctx context.Context, from, to time.Time, filterEnv, filterService string) map[sgEdgeKey]*sgEdgeData {
	logger := log.DefaultLogger.With("handler", "servicegraph")
	rangeStr := computeRangeStr(from, to)
	sgp := a.serviceGraphPrefix()

	labelFilter := envMatcher(a.otelCfg.Labels.DeploymentEnv, filterEnv)

	// When a service filter is provided, run two scoped queries (client=X OR
	// server=X) and merge results. This is dramatically faster than fetching
	// all edges and filtering client-side in large environments.
	if filterService != "" {
		return a.queryServiceGraphEdgesScoped(ctx, from, to, labelFilter, filterService)
	}

	rateQuery := fmt.Sprintf(
		`sum by (%s, %s, %s, %s, %s) (rate(%s%s%s%s))`,
		a.otelCfg.Labels.Client, a.otelCfg.Labels.Server, a.otelCfg.Labels.ConnectionType,
		a.otelCfg.Labels.DBSystem, a.otelCfg.Labels.MessagingSystem,
		sgp, a.otelCfg.ServiceGraph.RequestTotal, labelFilterStr(labelFilter), rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s%s%s%s))`,
		a.otelCfg.Labels.Client, a.otelCfg.Labels.Server, a.otelCfg.Labels.ConnectionType,
		sgp, a.otelCfg.ServiceGraph.RequestFailedTotal, labelFilterStr(labelFilter), rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s%s%s%s)))`,
		a.otelCfg.Labels.Client, a.otelCfg.Labels.Server, a.otelCfg.Labels.Le,
		sgp, a.otelCfg.ServiceGraph.RequestServerBucket, labelFilterStr(labelFilter), rangeStr,
	)

	resultMap := a.runInstantQueries(ctx, to, []QueryJob{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p95", p95Query},
	}, logger)

	edges := make(map[sgEdgeKey]*sgEdgeData)
	getEdge := func(client, server string) *sgEdgeData {
		k := sgEdgeKey{client, server}
		if e, ok := edges[k]; ok {
			return e
		}
		e := &sgEdgeData{}
		edges[k] = e
		return e
	}

	for _, r := range resultMap["rate"] {
		client := r.Metric[a.otelCfg.Labels.Client]
		server := r.Metric[a.otelCfg.Labels.Server]
		if client == "" || server == "" {
			continue
		}
		e := getEdge(client, server)
		e.rate = r.Value.Float()
		e.connType = r.Metric[a.otelCfg.Labels.ConnectionType]
		if ds := r.Metric[a.otelCfg.Labels.DBSystem]; ds != "" {
			e.dbSystem = ds
		}
		if ms := r.Metric[a.otelCfg.Labels.MessagingSystem]; ms != "" {
			e.messagingSystem = ms
		}
	}

	for _, r := range resultMap["error"] {
		client := r.Metric[a.otelCfg.Labels.Client]
		server := r.Metric[a.otelCfg.Labels.Server]
		if client == "" || server == "" {
			continue
		}
		getEdge(client, server).errorRate = r.Value.Float()
	}

	for _, r := range resultMap["p95"] {
		client := r.Metric[a.otelCfg.Labels.Client]
		server := r.Metric[a.otelCfg.Labels.Server]
		if client == "" || server == "" {
			continue
		}
		if v := r.Value.Float(); isValidMetricValue(v) {
			getEdge(client, server).p95 = v
		}
	}

	return edges
}

// queryServiceGraphEdgesScoped runs scoped queries for a single service
// (client=X OR server=X) and merges results. This avoids the expensive
// unscoped query that can time out in large environments.
func (a *App) queryServiceGraphEdgesScoped(ctx context.Context, from, to time.Time, baseLabelFilter, service string) map[sgEdgeKey]*sgEdgeData {
	logger := log.DefaultLogger.With("handler", "servicegraph-scoped", "service", service)
	rangeStr := computeRangeStr(from, to)
	sgp := a.serviceGraphPrefix()
	cfg := a.otelCfg

	// Build label filters for client=service and server=service
	clientFilter := fmt.Sprintf(`%s="%s"`, cfg.Labels.Client, service)
	serverFilter := fmt.Sprintf(`%s="%s"`, cfg.Labels.Server, service)
	if baseLabelFilter != "" {
		clientFilter += ", " + baseLabelFilter
		serverFilter += ", " + baseLabelFilter
	}

	// Rate: outbound (as client) + inbound (as server)
	outRateQ := fmt.Sprintf(
		`sum by (%s, %s, %s, %s, %s) (rate(%s%s{%s}%s))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.ConnectionType,
		cfg.Labels.DBSystem, cfg.Labels.MessagingSystem,
		sgp, cfg.ServiceGraph.RequestTotal, clientFilter, rangeStr,
	)
	inRateQ := fmt.Sprintf(
		`sum by (%s, %s, %s, %s, %s) (rate(%s%s{%s}%s))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.ConnectionType,
		cfg.Labels.DBSystem, cfg.Labels.MessagingSystem,
		sgp, cfg.ServiceGraph.RequestTotal, serverFilter, rangeStr,
	)

	// Error: outbound + inbound
	outErrQ := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s%s{%s}%s))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.ConnectionType,
		sgp, cfg.ServiceGraph.RequestFailedTotal, clientFilter, rangeStr,
	)
	inErrQ := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s%s{%s}%s))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.ConnectionType,
		sgp, cfg.ServiceGraph.RequestFailedTotal, serverFilter, rangeStr,
	)

	// P95: outbound + inbound
	outP95Q := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s%s{%s}%s)))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.Le,
		sgp, cfg.ServiceGraph.RequestServerBucket, clientFilter, rangeStr,
	)
	inP95Q := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s%s{%s}%s)))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.Le,
		sgp, cfg.ServiceGraph.RequestServerBucket, serverFilter, rangeStr,
	)

	resultMap := a.runInstantQueries(ctx, to, []QueryJob{
		{"outRate", outRateQ}, {"inRate", inRateQ},
		{"outErr", outErrQ}, {"inErr", inErrQ},
		{"outP95", outP95Q}, {"inP95", inP95Q},
	}, logger)

	edges := parseSGEdgeResults(resultMap, cfg)

	// Spanmetrics supplement: always query CLIENT spanmetrics to discover outbound
	// edges that the service graph cannot see (external services, cross-cluster
	// dependencies). The service graph only generates edges when both client and
	// server spans exist in Tempo — external targets like Azure AD or APIs in
	// other clusters won't appear. For inbound, only use as fallback when the
	// service graph has no data (it's authoritative for inbound since callers
	// are typically in the same Tempo).
	needOutbound := true
	inEmpty := len(resultMap["inRate"]) == 0
	if needOutbound || inEmpty {
		smEdges := a.querySpanmetricsTopologyFallback(ctx, from, to, baseLabelFilter, service, needOutbound, inEmpty)
		for k, v := range smEdges {
			if _, exists := edges[k]; !exists {
				edges[k] = v
			}
		}
	}

	return edges
}

const maxFrontierSize = 15

// queryServiceGraphEdgesBatch runs scoped service graph queries for multiple
// services at once using a regex filter (client=~"^(?:a|b|c)$"). This is used
// by multi-hop traversal to fetch edges for all frontier nodes in a single
// batch of 6 parallel queries instead of N×6 per-node queries.
func (a *App) queryServiceGraphEdgesBatch(ctx context.Context, from, to time.Time, baseLabelFilter string, services []string) map[sgEdgeKey]*sgEdgeData {
	if len(services) == 0 {
		return nil
	}
	logger := log.DefaultLogger.With("handler", "servicegraph-batch", "count", len(services))
	rangeStr := computeRangeStr(from, to)
	sgp := a.serviceGraphPrefix()
	cfg := a.otelCfg

	// Build regex alternation: ^(?:escaped1|escaped2|...)$
	escaped := make([]string, len(services))
	for i, s := range services {
		escaped[i] = regexp.QuoteMeta(s)
	}
	pattern := `^(?:` + strings.Join(escaped, "|") + `)$`

	clientFilter := fmt.Sprintf(`%s=~"%s"`, cfg.Labels.Client, pattern)
	serverFilter := fmt.Sprintf(`%s=~"%s"`, cfg.Labels.Server, pattern)
	if baseLabelFilter != "" {
		clientFilter += ", " + baseLabelFilter
		serverFilter += ", " + baseLabelFilter
	}

	outRateQ := fmt.Sprintf(
		`sum by (%s, %s, %s, %s, %s) (rate(%s%s{%s}%s))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.ConnectionType,
		cfg.Labels.DBSystem, cfg.Labels.MessagingSystem,
		sgp, cfg.ServiceGraph.RequestTotal, clientFilter, rangeStr,
	)
	inRateQ := fmt.Sprintf(
		`sum by (%s, %s, %s, %s, %s) (rate(%s%s{%s}%s))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.ConnectionType,
		cfg.Labels.DBSystem, cfg.Labels.MessagingSystem,
		sgp, cfg.ServiceGraph.RequestTotal, serverFilter, rangeStr,
	)
	outErrQ := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s%s{%s}%s))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.ConnectionType,
		sgp, cfg.ServiceGraph.RequestFailedTotal, clientFilter, rangeStr,
	)
	inErrQ := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s%s{%s}%s))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.ConnectionType,
		sgp, cfg.ServiceGraph.RequestFailedTotal, serverFilter, rangeStr,
	)
	outP95Q := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s%s{%s}%s)))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.Le,
		sgp, cfg.ServiceGraph.RequestServerBucket, clientFilter, rangeStr,
	)
	inP95Q := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s%s{%s}%s)))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.Le,
		sgp, cfg.ServiceGraph.RequestServerBucket, serverFilter, rangeStr,
	)

	resultMap := a.runInstantQueries(ctx, to, []QueryJob{
		{"outRate", outRateQ}, {"inRate", inRateQ},
		{"outErr", outErrQ}, {"inErr", inErrQ},
		{"outP95", outP95Q}, {"inP95", inP95Q},
	}, logger)

	return parseSGEdgeResults(resultMap, cfg)
}

// parseSGEdgeResults converts query results from the standard 6-query
// service graph pattern into an edge map. Shared by scoped and batch queries.
func parseSGEdgeResults(resultMap map[string][]queries.PromResult, cfg otelconfig.Config) map[sgEdgeKey]*sgEdgeData {
	edges := make(map[sgEdgeKey]*sgEdgeData)
	getEdge := func(client, server string) *sgEdgeData {
		k := sgEdgeKey{client, server}
		if e, ok := edges[k]; ok {
			return e
		}
		e := &sgEdgeData{}
		edges[k] = e
		return e
	}

	for _, key := range []string{"outRate", "inRate"} {
		for _, r := range resultMap[key] {
			client := r.Metric[cfg.Labels.Client]
			server := r.Metric[cfg.Labels.Server]
			if client == "" || server == "" {
				continue
			}
			e := getEdge(client, server)
			e.rate = r.Value.Float()
			e.connType = r.Metric[cfg.Labels.ConnectionType]
			if ds := r.Metric[cfg.Labels.DBSystem]; ds != "" {
				e.dbSystem = ds
			}
			if ms := r.Metric[cfg.Labels.MessagingSystem]; ms != "" {
				e.messagingSystem = ms
			}
		}
	}

	for _, key := range []string{"outErr", "inErr"} {
		for _, r := range resultMap[key] {
			client := r.Metric[cfg.Labels.Client]
			server := r.Metric[cfg.Labels.Server]
			if client == "" || server == "" {
				continue
			}
			getEdge(client, server).errorRate = r.Value.Float()
		}
	}

	for _, key := range []string{"outP95", "inP95"} {
		for _, r := range resultMap[key] {
			client := r.Metric[cfg.Labels.Client]
			server := r.Metric[cfg.Labels.Server]
			if client == "" || server == "" {
				continue
			}
			if v := r.Value.Float(); isValidMetricValue(v) {
				getEdge(client, server).p95 = v
			}
		}
	}

	return edges
}

// isInfraNode returns true if a node represents infrastructure (database,
// messaging) that should not be traversed further in multi-hop expansion.
func isInfraNode(edges map[sgEdgeKey]*sgEdgeData, name string) bool {
	for k, e := range edges {
		if k.server == name && (e.connType == "database" || e.connType == "messaging_system") {
			return true
		}
	}
	return false
}

// queryServiceMapMultiHop performs BFS traversal to discover multi-hop
// service topology. It starts from the focus service and iteratively
// expands to neighboring service nodes up to the specified depth.
func (a *App) queryServiceMapMultiHop(
	ctx context.Context,
	from, to time.Time,
	filterService, _, filterEnvironment string,
	depth int,
) ServiceMapResponse {
	logger := log.DefaultLogger.With("handler", "servicemap-multihop", "service", filterService, "depth", depth)

	baseLabelFilter := envMatcher(a.otelCfg.Labels.DeploymentEnv, filterEnvironment)

	// Hop 1: use the existing scoped query (includes spanmetrics fallback)
	allEdges := a.queryServiceGraphEdgesScoped(ctx, from, to, baseLabelFilter, filterService)

	explored := map[string]bool{filterService: true}

	// BFS: expand frontier nodes for additional hops
	for hop := 2; hop <= depth; hop++ {
		// Collect frontier: nodes discovered but not yet explored, excluding infra
		type frontierNode struct {
			name string
			rate float64
		}
		var frontier []frontierNode

		for k, e := range allEdges {
			for _, name := range []string{k.client, k.server} {
				if explored[name] || isInfraNode(allEdges, name) {
					continue
				}
				// Calculate this node's total edge rate for priority sorting
				frontier = append(frontier, frontierNode{name: name, rate: e.rate})
				explored[name] = true // mark to avoid re-adding
			}
		}

		if len(frontier) == 0 {
			logger.Info("BFS terminated early, no frontier", "hop", hop)
			break
		}

		// Sort by rate descending and cap at maxFrontierSize
		sort.Slice(frontier, func(i, j int) bool {
			return frontier[i].rate > frontier[j].rate
		})
		if len(frontier) > maxFrontierSize {
			frontier = frontier[:maxFrontierSize]
		}

		names := make([]string, len(frontier))
		for i, f := range frontier {
			names[i] = f.name
		}
		logger.Info("Expanding frontier", "hop", hop, "nodes", len(names))

		batchEdges := a.queryServiceGraphEdgesBatch(ctx, from, to, baseLabelFilter, names)
		for k, v := range batchEdges {
			if _, exists := allEdges[k]; !exists {
				allEdges[k] = v
			}
		}
	}

	// Assemble the final response using the shared assembly logic
	return assembleServiceMapResponse(allEdges)
}
// when service graph metrics are unavailable (e.g., environments without the
// Tempo service graph processor). It queries calls_total with server_address and
// http_host labels to find outbound and inbound connections.
func (a *App) querySpanmetricsTopologyFallback(
	ctx context.Context, from, to time.Time, baseLabelFilter, service string,
	needOutbound, needInbound bool,
) map[sgEdgeKey]*sgEdgeData {
	logger := log.DefaultLogger.With("handler", "servicegraph-sm-fallback", "service", service)
	rangeStr := computeRangeStr(from, to)
	cfg := a.otelCfg
	callsMetric := a.callsMetric(ctx)

	envFilter := ""
	if baseLabelFilter != "" {
		envFilter = ", " + baseLabelFilter
	}

	escapedSvc := promQLEscape(service)

	var jobs []QueryJob

	if needOutbound {
		// Outbound: our service as client, find what it calls via server_address / http_host
		outRateQ := fmt.Sprintf(
			`sum by (%s, %s, %s) (rate(%s{%s="%s", %s="%s"%s}%s))`,
			cfg.Labels.ServerAddress, cfg.Labels.DBSystem, cfg.Labels.MessagingSystem,
			callsMetric, cfg.Labels.SpanKind, cfg.SpanKinds.Client,
			cfg.Labels.ServiceName, service, envFilter, rangeStr,
		)
		outRateHostQ := fmt.Sprintf(
			`sum by (%s, %s, %s) (rate(%s{%s="%s", %s="%s", %s=""%s}%s))`,
			cfg.Labels.HTTPHost, cfg.Labels.DBSystem, cfg.Labels.MessagingSystem,
			callsMetric, cfg.Labels.SpanKind, cfg.SpanKinds.Client,
			cfg.Labels.ServiceName, service,
			cfg.Labels.ServerAddress, envFilter, rangeStr,
		)
		outErrQ := fmt.Sprintf(
			`sum by (%s) (rate(%s{%s="%s", %s="%s", %s="%s"%s}%s))`,
			cfg.Labels.ServerAddress,
			callsMetric, cfg.Labels.SpanKind, cfg.SpanKinds.Client,
			cfg.Labels.ServiceName, service,
			cfg.Labels.StatusCode, cfg.StatusCodes.Error, envFilter, rangeStr,
		)
		outErrHostQ := fmt.Sprintf(
			`sum by (%s) (rate(%s{%s="%s", %s="%s", %s="%s", %s=""%s}%s))`,
			cfg.Labels.HTTPHost,
			callsMetric, cfg.Labels.SpanKind, cfg.SpanKinds.Client,
			cfg.Labels.ServiceName, service,
			cfg.Labels.StatusCode, cfg.StatusCodes.Error,
			cfg.Labels.ServerAddress, envFilter, rangeStr,
		)
		jobs = append(jobs,
			QueryJob{"smOutRate", outRateQ},
			QueryJob{"smOutRateHost", outRateHostQ},
			QueryJob{"smOutErr", outErrQ},
			QueryJob{"smOutErrHost", outErrHostQ},
		)
	}

	if needInbound {
		// Inbound: other services calling us, found via their CLIENT spans
		// targeting our service by server_address or http_host
		inRateQ := fmt.Sprintf(
			`sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s($|[.:].*?)"%s}%s))`,
			cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
			callsMetric, cfg.Labels.SpanKind, cfg.SpanKinds.Client,
			cfg.Labels.ServerAddress, escapedSvc, envFilter, rangeStr,
		)
		inRateHostQ := fmt.Sprintf(
			`sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s($|[.:].*?)"%s}%s))`,
			cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
			callsMetric, cfg.Labels.SpanKind, cfg.SpanKinds.Client,
			cfg.Labels.HTTPHost, escapedSvc, envFilter, rangeStr,
		)
		inErrQ := fmt.Sprintf(
			`sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s($|[.:].*?)", %s="%s"%s}%s))`,
			cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
			callsMetric, cfg.Labels.SpanKind, cfg.SpanKinds.Client,
			cfg.Labels.ServerAddress, escapedSvc,
			cfg.Labels.StatusCode, cfg.StatusCodes.Error, envFilter, rangeStr,
		)
		inErrHostQ := fmt.Sprintf(
			`sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s($|[.:].*?)", %s="%s"%s}%s))`,
			cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
			callsMetric, cfg.Labels.SpanKind, cfg.SpanKinds.Client,
			cfg.Labels.HTTPHost, escapedSvc,
			cfg.Labels.StatusCode, cfg.StatusCodes.Error, envFilter, rangeStr,
		)
		jobs = append(jobs,
			QueryJob{"smInRate", inRateQ},
			QueryJob{"smInRateHost", inRateHostQ},
			QueryJob{"smInErr", inErrQ},
			QueryJob{"smInErrHost", inErrHostQ},
		)
	}

	if len(jobs) == 0 {
		return nil
	}

	resultMap := a.runInstantQueries(ctx, to, jobs, logger)

	edges := make(map[sgEdgeKey]*sgEdgeData)
	getEdge := func(client, server string) *sgEdgeData {
		k := sgEdgeKey{client, server}
		if e, ok := edges[k]; ok {
			return e
		}
		e := &sgEdgeData{}
		edges[k] = e
		return e
	}

	// Process outbound edges (our service → targets via server_address/http_host)
	for _, key := range []string{"smOutRate", "smOutRateHost"} {
		addrLabel := cfg.Labels.ServerAddress
		if key == "smOutRateHost" {
			addrLabel = cfg.Labels.HTTPHost
		}
		for _, r := range resultMap[key] {
			addr := r.Metric[addrLabel]
			if addr == "" {
				continue
			}
			serverName := extractTopologyNodeName(addr)
			if serverName == "" || serverName == service {
				continue
			}
			e := getEdge(service, serverName)
			e.rate += r.Value.Float()
			if ds := r.Metric[cfg.Labels.DBSystem]; ds != "" {
				e.dbSystem = ds
			}
			if ms := r.Metric[cfg.Labels.MessagingSystem]; ms != "" {
				e.messagingSystem = ms
			}
		}
	}

	// Process outbound errors
	for _, key := range []string{"smOutErr", "smOutErrHost"} {
		addrLabel := cfg.Labels.ServerAddress
		if key == "smOutErrHost" {
			addrLabel = cfg.Labels.HTTPHost
		}
		for _, r := range resultMap[key] {
			addr := r.Metric[addrLabel]
			if addr == "" {
				continue
			}
			serverName := extractTopologyNodeName(addr)
			if serverName == "" || serverName == service {
				continue
			}
			getEdge(service, serverName).errorRate += r.Value.Float()
		}
	}

	// Process inbound edges (callers → our service)
	for _, key := range []string{"smInRate", "smInRateHost"} {
		for _, r := range resultMap[key] {
			caller := r.Metric[cfg.Labels.ServiceName]
			if caller == "" || caller == service {
				continue
			}
			e := getEdge(caller, service)
			e.rate += r.Value.Float()
		}
	}

	// Process inbound errors
	for _, key := range []string{"smInErr", "smInErrHost"} {
		for _, r := range resultMap[key] {
			caller := r.Metric[cfg.Labels.ServiceName]
			if caller == "" || caller == service {
				continue
			}
			getEdge(caller, service).errorRate += r.Value.Float()
		}
	}

	logger.Info("Spanmetrics fallback results",
		"outbound", needOutbound, "inbound", needInbound,
		"edges", len(edges))

	return edges
}

// extractTopologyNodeName converts a server_address/http_host value into a
// clean node name for the topology graph. Internal Kubernetes FQDNs are
// collapsed to their service name; IPs and external hosts are normalized.
func extractTopologyNodeName(addr string) string {
	if addr == "" {
		return ""
	}
	host, port, hasPort := strings.Cut(addr, ":")
	host = strings.TrimRight(host, ".")
	host = strings.ToLower(host)

	// Keep IP addresses as-is (with port if non-standard)
	if net.ParseIP(host) != nil {
		if hasPort && port != "443" && port != "80" {
			return host + ":" + port
		}
		return host
	}

	// Kubernetes FQDN: extract the service name (first component)
	if strings.Contains(host, ".svc") {
		if idx := strings.Index(host, "."); idx > 0 {
			return host[:idx]
		}
	}

	// Short names with port (e.g., "mydb:5432") — extract just the name
	// if the name looks like a K8s service (no dots)
	if hasPort && !strings.Contains(host, ".") {
		return host
	}

	// External hostnames: normalize (strip standard ports)
	return normalizeAddress(addr)
}

func (a *App) queryServiceMap( //nolint:gocyclo // complex due to filtering + node/edge assembly
	ctx context.Context,
	from, to time.Time,
	filterService, filterNamespace, filterEnvironment string,
) ServiceMapResponse {
	// When a filterService is specified, pass it to queryServiceGraphEdges so
	// that service graph queries are scoped directly in PromQL (client=X OR
	// server=X). This avoids fetching ALL edges in large environments, which
	// can time out in Mimir when there are thousands of services.
	// When no filterService is specified (namespace-level view), the unscoped
	// query is used and filtering happens post-query.
	edges := a.queryServiceGraphEdges(ctx, from, to, filterEnvironment, filterService)

	// Apply namespace filter: keep edges where at least one end belongs to the namespace.
	// Service graph metrics lack namespace labels, so we build a name→namespace mapping
	// from spanmetrics (which DO carry service_namespace).
	//
	// Skip the namespace filter when a service filter is active: the scoped queries
	// already return only that service's direct neighbors, and the namespace filter
	// would incorrectly remove cross-namespace callers/callees (or all edges if
	// the nsMap query fails in large environments).
	if filterNamespace != "" && filterService == "" {
		nsMap := a.buildServiceNamespaceMap(ctx, to, filterEnvironment)
		filtered := make(map[sgEdgeKey]*sgEdgeData)
		for k, e := range edges {
			if nsMap[k.client] == filterNamespace || nsMap[k.server] == filterNamespace {
				filtered[k] = e
			}
		}
		edges = filtered
	}

	// Calculate per-node aggregate error rates for display.
	return assembleServiceMapResponse(edges)
}

// assembleServiceMapResponse converts raw edge data into the final response
// with node aggregation, type inference, and formatted stats.
func assembleServiceMapResponse(edges map[sgEdgeKey]*sgEdgeData) ServiceMapResponse {
	nodeSet := make(map[string]bool)
	for k := range edges {
		nodeSet[k.client] = true
		nodeSet[k.server] = true
	}

	// Calculate per-node aggregate error rates for display.
	// Use only edges where the node is the server (incoming traffic)
	// to avoid double-counting across client/server roles.
	type nodeAgg struct {
		totalRate float64
		errorRate float64
	}
	nodeAggs := make(map[string]*nodeAgg)
	for k, e := range edges {
		agg, ok := nodeAggs[k.server]
		if !ok {
			agg = &nodeAgg{}
			nodeAggs[k.server] = agg
		}
		agg.totalRate += e.rate
		agg.errorRate += e.errorRate

		if _, ok := nodeAggs[k.client]; !ok {
			nodeAggs[k.client] = &nodeAgg{}
		}
	}

	// Infer node types and subtitles from edge labels.
	// db_system and messaging_system come directly from service graph metrics,
	// so no separate spanmetrics enrichment query is needed.
	// Build a set of nodes that appear as clients — these are real services,
	// not infrastructure, so they should never be typed as database/messaging.
	clientNodes := make(map[string]bool)
	for k := range edges {
		clientNodes[k.client] = true
	}

	nodeTypes := make(map[string]string)
	nodeSubtitles := make(map[string]string)
	for k, e := range edges {
		if e.connType != "" {
			// If a node also appears as a client in any edge it's a real
			// service, not infrastructure — skip type override.
			if clientNodes[k.server] {
				continue
			}
			switch e.connType {
			case "database":
				nodeTypes[k.server] = "database"
				if e.dbSystem != "" {
					nodeSubtitles[k.server] = normalizeDBSystem(e.dbSystem)
				}
			case "messaging_system":
				nodeTypes[k.server] = "messaging"
				if e.messagingSystem != "" {
					nodeSubtitles[k.server] = e.messagingSystem
				}
			default:
				if _, exists := nodeTypes[k.server]; !exists {
					nodeTypes[k.server] = "external"
				}
			}
		}
	}

	nodes := make([]ServiceMapNode, 0, len(nodeSet))
	for name := range nodeSet {
		agg := nodeAggs[name]
		errPct := 0.0
		if agg != nil && agg.totalRate > 0 {
			errPct = agg.errorRate / agg.totalRate
			if errPct > 1.0 {
				errPct = 1.0
			}
		}
		totalRate := 0.0
		if agg != nil {
			totalRate = agg.totalRate
		}
		nType := nodeTypes[name]
		if nType == "" {
			nType = "service"
		}

		nodes = append(nodes, ServiceMapNode{
			ID:            name,
			Title:         name,
			SubTitle:      nodeSubtitles[name],
			MainStat:      fmt.Sprintf("%.1f req/s", totalRate),
			SecondaryStat: fmt.Sprintf("%.1f%% errors", errPct*100),
			ArcErrors:     errPct,
			ArcOK:         1 - errPct,
			NodeType:      nType,
			IsSidecar:     isSidecar(name),
			ErrorRate:     errPct,
		})
	}

	edgeList := make([]ServiceMapEdge, 0, len(edges))
	for k, e := range edges {
		mainStat := fmt.Sprintf("%.1f req/s", e.rate)
		secondaryStat := ""
		if e.p95 > 0 {
			secondaryStat = fmt.Sprintf("P95: %.0fms", e.p95*1000)
		}
		edgeList = append(edgeList, ServiceMapEdge{
			ID:            fmt.Sprintf("%s->%s", k.client, k.server),
			Source:        k.client,
			Target:        k.server,
			MainStat:      mainStat,
			SecondaryStat: secondaryStat,
		})
	}

	return ServiceMapResponse{Nodes: nodes, Edges: edgeList}
}

func labelFilterStr(filter string) string {
	if filter == "" {
		return ""
	}
	return "{" + filter + "}"
}

// buildServiceNamespaceMap queries spanmetrics to build a service_name → service_namespace
// mapping. Service graph metrics lack namespace labels, so this mapping is used
// to filter edges by namespace. The query is cheap (group by, no rate computation)
// and results are cached for the response cache TTL.
func (a *App) buildServiceNamespaceMap(ctx context.Context, to time.Time, filterEnv string) map[string]string {
	logger := log.DefaultLogger.With("handler", "nsmap")

	orgID := httpHeaders(ctx).Get("X-Grafana-Org-Id")
	roundedTo := fmt.Sprintf("%d", to.Unix()/30*30)
	ck := cacheKey("nsmap", orgID, roundedTo, filterEnv)
	if cached, ok := a.respCache.get(ck); ok {
		var nsMap map[string]string
		if err := json.Unmarshal(cached, &nsMap); err == nil {
			return nsMap
		}
	}

	callsMetric := a.callsMetric(ctx)
	envFilter := ""
	if m := envMatcher(a.otelCfg.Labels.DeploymentEnv, filterEnv); m != "" {
		envFilter = ", " + m
	}
	query := fmt.Sprintf(`group by (%s, %s) (%s{%s!=""%s})`,
		a.otelCfg.Labels.ServiceName, a.otelCfg.Labels.ServiceNamespace,
		callsMetric, a.otelCfg.Labels.ServiceName, envFilter,
	)

	results, err := a.prom(ctx).InstantQuery(ctx, query, to)
	if err != nil {
		logger.Warn("Failed to build service namespace map", "error", err)
		return map[string]string{}
	}

	nsMap := make(map[string]string, len(results))
	for _, r := range results {
		name := r.Metric[a.otelCfg.Labels.ServiceName]
		ns := r.Metric[a.otelCfg.Labels.ServiceNamespace]
		if name == "" || ns == "" {
			continue
		}
		if existing, dup := nsMap[name]; dup && existing != ns {
			logger.Warn("Service name exists in multiple namespaces, using first seen",
				"service", name, "namespace1", existing, "namespace2", ns)
			continue
		}
		nsMap[name] = ns
	}

	a.respCache.setJSON(ck, nsMap)
	return nsMap
}

// formatDepDisplayName returns a human-readable display name for a dependency
// using db_system or messaging_system labels from service graph metrics.
// Format: "postgresql (100.71.2.33)" or "kafka (broker-name)".
// Returns empty string when no enrichment data is available.
func formatDepDisplayName(name, dbSystem, messagingSystem string) string {
	if dbSystem != "" {
		return fmt.Sprintf("%s (%s)", normalizeDBSystem(dbSystem), name)
	}
	if messagingSystem != "" {
		return fmt.Sprintf("%s (%s)", messagingSystem, name)
	}
	return ""
}
