package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// ServiceMapNode, ServiceMapEdge, ServiceMapResponse → models.go

// sanitizeLogValue strips newlines and control characters from user input
// to prevent log injection attacks.
func sanitizeLogValue(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return '_'
		}
		return r
	}, s)
}

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
	debug := req.URL.Query().Get("debug") == "1"
	ck := cacheKey("servicemap", orgID, roundedFrom, roundedTo, filterService, filterNamespace, filterEnvironment, fmt.Sprintf("d%d", depth))
	if !debug {
		if cached, ok := a.respCache.get(ck); ok {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Cache", "HIT")
			_, _ = w.Write(cached)
			return
		}
	}

	var graph ServiceMapResponse
	if depth > 1 && filterService != "" {
		if debug {
			debugInfo := a.debugServiceMapMultiHop(ctx, from, to, filterService, filterEnvironment, depth)
			writeJSON(w, debugInfo)
			return
		}
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
	logger := log.DefaultLogger.With("handler", "servicegraph-scoped", "service", sanitizeLogValue(service))
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

// hubDegreeThreshold is the minimum directional degree (number of distinct
// neighbors in the expansion direction) that causes a node to be classified
// as a "hub" and excluded from BFS expansion. Hub nodes are still shown in
// the graph but not traversed further, preventing shared infrastructure
// (reverse proxies, token exchanges, ingress gateways) from exploding the
// topology at depth 2+.
const hubDegreeThreshold = 50

// ratePruneRatio controls the minimum edge rate relative to the parent's entry
// rate for an edge to be included at hop 2+. Edges with rate < parentRate *
// ratePruneRatio are pruned as likely unrelated to the focus service's traffic.
const ratePruneRatio = 0.01

// ratePruneAbsoluteMin is the absolute minimum rate (req/s) below which edges
// are always pruned at hop 2+, regardless of the parent ratio. This prevents
// noise from very low-volume edges.
const ratePruneAbsoluteMin = 0.001

// queryNodeDegrees returns the directional degree (distinct neighbor count) for
// each service. outDegree counts distinct servers a service calls; inDegree
// counts distinct clients that call it. Uses sum-then-count to avoid inflated
// counts from extra label dimensions.
func (a *App) queryNodeDegrees(ctx context.Context, to time.Time, baseLabelFilter string, services []string) (outDegree, inDegree map[string]int) {
	if len(services) == 0 {
		return nil, nil
	}
	logger := log.DefaultLogger.With("handler", "node-degrees", "count", len(services))
	cfg := a.otelCfg
	sgp := a.serviceGraphPrefix()

	escaped := make([]string, len(services))
	for i, s := range services {
		escaped[i] = promQLEscape(s)
	}
	pattern := `^(?:` + strings.Join(escaped, "|") + `)$`

	envFilter := ""
	if baseLabelFilter != "" {
		envFilter = ", " + baseLabelFilter
	}

	outQ := fmt.Sprintf(
		`count by (%s) (sum by (%s, %s) (rate(%s%s{%s=~"%s"%s}[1h])))`,
		cfg.Labels.Client, cfg.Labels.Client, cfg.Labels.Server,
		sgp, cfg.ServiceGraph.RequestTotal, cfg.Labels.Client, pattern, envFilter,
	)
	inQ := fmt.Sprintf(
		`count by (%s) (sum by (%s, %s) (rate(%s%s{%s=~"%s"%s}[1h])))`,
		cfg.Labels.Server, cfg.Labels.Client, cfg.Labels.Server,
		sgp, cfg.ServiceGraph.RequestTotal, cfg.Labels.Server, pattern, envFilter,
	)

	resultMap := a.runInstantQueries(ctx, to, []QueryJob{
		{"outDeg", outQ}, {"inDeg", inQ},
	}, logger)

	outDegree = make(map[string]int)
	for _, r := range resultMap["outDeg"] {
		name := r.Metric[cfg.Labels.Client]
		if name != "" {
			outDegree[name] = int(r.Value.Float())
		}
	}
	inDegree = make(map[string]int)
	for _, r := range resultMap["inDeg"] {
		name := r.Metric[cfg.Labels.Server]
		if name != "" {
			inDegree[name] = int(r.Value.Float())
		}
	}
	logger.Info("Degree query complete", "outNodes", len(outDegree), "inNodes", len(inDegree))
	return outDegree, inDegree
}

// queryServiceGraphEdgesDirected queries edges for frontier services in a
// single direction only. If outbound=true, queries edges where the services
// appear as CLIENT (finding what they call). If outbound=false, queries where
// they appear as SERVER (finding what calls them). This produces proper layered
// tree expansion rather than bidirectional blowup.
func (a *App) queryServiceGraphEdgesDirected(ctx context.Context, from, to time.Time, baseLabelFilter string, services []string, outbound bool) map[sgEdgeKey]*sgEdgeData {
	if len(services) == 0 {
		return nil
	}
	direction := "outbound"
	if !outbound {
		direction = "inbound"
	}
	logger := log.DefaultLogger.With("handler", "servicegraph-directed", "dir", direction, "count", len(services))
	rangeStr := computeRangeStr(from, to)
	sgp := a.serviceGraphPrefix()
	cfg := a.otelCfg

	escaped := make([]string, len(services))
	for i, s := range services {
		escaped[i] = promQLEscape(s)
	}
	pattern := `^(?:` + strings.Join(escaped, "|") + `)$`

	var labelFilter string
	if outbound {
		labelFilter = fmt.Sprintf(`%s=~"%s"`, cfg.Labels.Client, pattern)
	} else {
		labelFilter = fmt.Sprintf(`%s=~"%s"`, cfg.Labels.Server, pattern)
	}
	if baseLabelFilter != "" {
		labelFilter += ", " + baseLabelFilter
	}

	rateQ := fmt.Sprintf(
		`sum by (%s, %s, %s, %s, %s) (rate(%s%s{%s}%s))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.ConnectionType,
		cfg.Labels.DBSystem, cfg.Labels.MessagingSystem,
		sgp, cfg.ServiceGraph.RequestTotal, labelFilter, rangeStr,
	)
	errQ := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s%s{%s}%s))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.ConnectionType,
		sgp, cfg.ServiceGraph.RequestFailedTotal, labelFilter, rangeStr,
	)
	p95Q := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s%s{%s}%s)))`,
		cfg.Labels.Client, cfg.Labels.Server, cfg.Labels.Le,
		sgp, cfg.ServiceGraph.RequestServerBucket, labelFilter, rangeStr,
	)

	resultMap := a.runInstantQueries(ctx, to, []QueryJob{
		{"rate", rateQ}, {"err", errQ}, {"p95", p95Q},
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
		client := r.Metric[cfg.Labels.Client]
		server := r.Metric[cfg.Labels.Server]
		if client == "" || server == "" {
			continue
		}
		e := getEdge(client, server)
		e.rate = r.Value.Float()
		e.connType = r.Metric[cfg.Labels.ConnectionType]
		e.dbSystem = r.Metric[cfg.Labels.DBSystem]
		e.messagingSystem = r.Metric[cfg.Labels.MessagingSystem]
	}
	for _, r := range resultMap["err"] {
		client := r.Metric[cfg.Labels.Client]
		server := r.Metric[cfg.Labels.Server]
		if client == "" || server == "" {
			continue
		}
		if e, ok := edges[sgEdgeKey{client, server}]; ok {
			e.errorRate = r.Value.Float()
		}
	}
	for _, r := range resultMap["p95"] {
		client := r.Metric[cfg.Labels.Client]
		server := r.Metric[cfg.Labels.Server]
		if client == "" || server == "" {
			continue
		}
		if e, ok := edges[sgEdgeKey{client, server}]; ok {
			e.p95 = r.Value.Float()
		}
	}

	// Spanmetrics supplement for outbound direction only
	if outbound {
		smEdges := a.querySpanmetricsTopologyBatch(ctx, from, to, baseLabelFilter, services)
		svcSet := make(map[string]bool, len(services))
		for _, s := range services {
			svcSet[s] = true
		}
		for k, v := range smEdges {
			if svcSet[k.client] {
				if _, exists := edges[k]; !exists {
					edges[k] = v
				}
			}
		}
	}

	logger.Info("Directed query complete", "edges", len(edges))
	return edges
}

// querySpanmetricsTopologyBatch discovers outbound edges for multiple services
// at once using CLIENT spanmetrics (server_address/http_host). This supplements
// the service graph batch query to find external dependencies.
func (a *App) querySpanmetricsTopologyBatch(
	ctx context.Context, from, to time.Time, baseLabelFilter string, services []string,
) map[sgEdgeKey]*sgEdgeData {
	if len(services) == 0 {
		return nil
	}
	logger := log.DefaultLogger.With("handler", "servicegraph-sm-batch", "count", len(services))
	rangeStr := computeRangeStr(from, to)
	cfg := a.otelCfg
	callsMetric := a.callsMetric(ctx)

	// Build regex for service names
	escaped := make([]string, len(services))
	for i, s := range services {
		escaped[i] = promQLEscape(s)
	}
	svcPattern := strings.Join(escaped, "|")

	envFilter := ""
	if baseLabelFilter != "" {
		envFilter = ", " + baseLabelFilter
	}

	// Outbound: frontier services as clients, discover their targets
	outRateQ := fmt.Sprintf(
		`sum by (%s, %s, %s, %s) (rate(%s{%s="%s", %s=~"%s"%s}%s))`,
		cfg.Labels.ServiceName, cfg.Labels.ServerAddress, cfg.Labels.DBSystem, cfg.Labels.MessagingSystem,
		callsMetric, cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.ServiceName, svcPattern, envFilter, rangeStr,
	)
	outRateHostQ := fmt.Sprintf(
		`sum by (%s, %s, %s, %s) (rate(%s{%s="%s", %s=~"%s", %s=""%s}%s))`,
		cfg.Labels.ServiceName, cfg.Labels.HTTPHost, cfg.Labels.DBSystem, cfg.Labels.MessagingSystem,
		callsMetric, cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.ServiceName, svcPattern,
		cfg.Labels.ServerAddress, envFilter, rangeStr,
	)

	// Inbound: find callers of the frontier services via server_address
	inPattern := `(?:` + svcPattern + `)($|[.:].*?)`
	inRateQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s"%s}%s))`,
		cfg.Labels.ServiceName, cfg.Labels.ServerAddress,
		callsMetric, cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.ServerAddress, inPattern, envFilter, rangeStr,
	)

	resultMap := a.runInstantQueries(ctx, to, []QueryJob{
		{"smBatchOutRate", outRateQ},
		{"smBatchOutRateHost", outRateHostQ},
		{"smBatchInRate", inRateQ},
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

	// Build a set of frontier services for filtering
	svcSet := make(map[string]bool, len(services))
	for _, s := range services {
		svcSet[s] = true
	}

	// Process outbound edges
	for _, key := range []string{"smBatchOutRate", "smBatchOutRateHost"} {
		addrLabel := cfg.Labels.ServerAddress
		if key == "smBatchOutRateHost" {
			addrLabel = cfg.Labels.HTTPHost
		}
		for _, r := range resultMap[key] {
			svc := r.Metric[cfg.Labels.ServiceName]
			addr := r.Metric[addrLabel]
			if svc == "" || addr == "" {
				continue
			}
			serverName := a.resolveIngressAlias(extractTopologyNodeName(addr))
			if serverName == "" || serverName == svc {
				continue
			}
			e := getEdge(svc, serverName)
			e.rate += r.Value.Float()
			if ds := r.Metric[cfg.Labels.DBSystem]; ds != "" {
				e.dbSystem = ds
			}
			if ms := r.Metric[cfg.Labels.MessagingSystem]; ms != "" {
				e.messagingSystem = ms
			}
		}
	}

	// Process inbound edges
	for _, r := range resultMap["smBatchInRate"] {
		caller := r.Metric[cfg.Labels.ServiceName]
		addr := r.Metric[cfg.Labels.ServerAddress]
		if caller == "" || addr == "" {
			continue
		}
		serverName := a.resolveIngressAlias(extractTopologyNodeName(addr))
		if serverName == "" || serverName == caller {
			continue
		}
		// Only keep if the server is one of our frontier services
		if !svcSet[serverName] {
			continue
		}
		e := getEdge(caller, serverName)
		e.rate += r.Value.Float()
	}

	logger.Info("Spanmetrics batch results", "edges", len(edges))
	return edges
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

// bfsDirection indicates which side of the focus service a frontier node is on.
type bfsDirection int

const (
	bfsDirOutbound bfsDirection = iota // node discovered as a dependency (right side)
	bfsDirInbound                      // node discovered as a caller (left side)
)

// bfsState holds the mutable state for the multi-hop BFS traversal.
type bfsState struct {
	allEdges  map[sgEdgeKey]*sgEdgeData
	nodeDir    map[string]bfsDirection
	entryRate  map[string]float64
	hubNodes   map[string]int // name → directional degree
	infraNodes map[string]bool
	seen       map[string]bool
	expanded   map[string]bool
	focus      string
}

// frontierNode represents a candidate for BFS expansion.
type frontierNode struct {
	name string
	rate float64
	dir  bfsDirection
}

// initBFSState creates the initial BFS state after hop 1.
func initBFSState(focus string, edges map[sgEdgeKey]*sgEdgeData) *bfsState {
	s := &bfsState{
		allEdges:   edges,
		nodeDir:    make(map[string]bfsDirection),
		entryRate:  make(map[string]float64),
		hubNodes:   make(map[string]int),
		infraNodes: make(map[string]bool),
		seen:       map[string]bool{focus: true},
		expanded:   map[string]bool{focus: true},
		focus:      focus,
	}
	for k, e := range edges {
		// Track infrastructure nodes (databases, messaging systems)
		if e.connType == "database" || e.connType == "messaging_system" {
			s.infraNodes[k.server] = true
		}
		if k.client == focus && k.server != focus {
			s.nodeDir[k.server] = bfsDirOutbound
		}
		if k.server == focus && k.client != focus {
			s.nodeDir[k.client] = bfsDirInbound
		}
		for _, name := range []string{k.client, k.server} {
			if name != focus {
				if existing, ok := s.entryRate[name]; !ok || e.rate > existing {
					s.entryRate[name] = e.rate
				}
			}
		}
	}
	return s
}

// buildCandidates discovers nodes not yet seen that could be expanded.
// Uses two passes to ensure deterministic rate assignment (max rate wins).
func (s *bfsState) buildCandidates() []frontierNode {
	// First pass: find max rate and a representative edge for each unseen node
	type candidateInfo struct {
		maxRate float64
		bestKey sgEdgeKey
	}
	unseen := make(map[string]*candidateInfo)
	for k, e := range s.allEdges {
		for _, name := range []string{k.client, k.server} {
			if s.seen[name] || s.infraNodes[name] {
				continue
			}
			if info, ok := unseen[name]; ok {
				if e.rate > info.maxRate {
					info.maxRate = e.rate
					info.bestKey = k
				}
			} else {
				unseen[name] = &candidateInfo{maxRate: e.rate, bestKey: k}
			}
		}
	}
	// Second pass: build candidates with deterministic max rate
	candidates := make([]frontierNode, 0, len(unseen))
	for name, info := range unseen {
		dir := s.inferDirection(info.bestKey, name)
		candidates = append(candidates, frontierNode{name: name, rate: info.maxRate, dir: dir})
		s.seen[name] = true
	}
	return candidates
}

// inferDirection determines the BFS direction for a node based on its position
// in an edge and known directions of adjacent nodes.
func (s *bfsState) inferDirection(k sgEdgeKey, name string) bfsDirection {
	if dir, ok := s.nodeDir[name]; ok {
		return dir
	}
	var dir bfsDirection
	if k.server == name {
		if cd, ok := s.nodeDir[k.client]; ok {
			dir = cd
		} else {
			dir = bfsDirOutbound
		}
	} else {
		if sd, ok := s.nodeDir[k.server]; ok {
			dir = sd
		} else {
			dir = bfsDirInbound
		}
	}
	s.nodeDir[name] = dir
	return dir
}

// filterHubs separates hub nodes from expandable frontier candidates.
func (s *bfsState) filterHubs(candidates []frontierNode, outDegree, inDegree map[string]int) []frontierNode {
	var expandable []frontierNode
	for _, c := range candidates {
		n := normalizeServiceName(c.name)
		var dirDegree int
		if c.dir == bfsDirOutbound {
			dirDegree = outDegree[n]
		} else {
			dirDegree = inDegree[n]
		}
		if dirDegree >= hubDegreeThreshold {
			s.hubNodes[c.name] = dirDegree
			s.expanded[c.name] = true
			continue
		}
		expandable = append(expandable, c)
	}
	return expandable
}

// splitFrontier splits frontier nodes by direction and normalizes names.
func (s *bfsState) splitFrontier(frontier []frontierNode) (outNames, inNames []string) {
	outSeen := map[string]bool{}
	inSeen := map[string]bool{}
	for _, f := range frontier {
		n := normalizeServiceName(f.name)
		if n == s.focus {
			continue
		}
		s.expanded[f.name] = true
		if f.dir == bfsDirOutbound && !outSeen[n] {
			outNames = append(outNames, n)
			outSeen[n] = true
		} else if f.dir == bfsDirInbound && !inSeen[n] {
			inNames = append(inNames, n)
			inSeen[n] = true
		}
	}
	return outNames, inNames
}

// mergeEdgesWithPruning adds hop-N edges into allEdges, applying rate-weighted
// pruning. parentKey is "client" for outbound or "server" for inbound. Returns
// the number of edges added.
func (s *bfsState) mergeEdgesWithPruning(hopEdges map[sgEdgeKey]*sgEdgeData, outbound bool) int {
	added := 0
	for k, v := range hopEdges {
		if _, exists := s.allEdges[k]; exists {
			continue
		}
		parentName := k.client
		if !outbound {
			parentName = k.server
		}
		// Rate-weighted pruning: compute threshold from the higher of
		// the absolute minimum and the parent's proportional rate.
		parentRate := s.entryRate[parentName]
		minRate := ratePruneAbsoluteMin
		if rel := parentRate * ratePruneRatio; rel > minRate {
			minRate = rel
		}
		if v.rate < minRate {
			continue
		}
		s.allEdges[k] = v
		added++
		// Track infrastructure nodes from new edges
		if v.connType == "database" || v.connType == "messaging_system" {
			s.infraNodes[k.server] = true
		}
		// Track direction and entry rate for newly discovered nodes
		newNode := k.server
		dir := bfsDirOutbound
		if !outbound {
			newNode = k.client
			dir = bfsDirInbound
		}
		if _, known := s.nodeDir[newNode]; !known {
			s.nodeDir[newNode] = dir
		}
		if existing, ok := s.entryRate[newNode]; !ok || v.rate > existing {
			s.entryRate[newNode] = v.rate
		}
	}
	return added
}

// queryServiceMapMultiHop performs direction-aware BFS traversal to discover
// multi-hop service topology. It starts from the focus service and iteratively
// expands outbound dependencies rightward and inbound callers leftward,
// creating proper layered depth in the graph.
//
// Two pruning layers prevent graph explosions from shared infrastructure:
//   - Hub detection: nodes with directional degree >= hubDegreeThreshold are
//     shown but not expanded (e.g., wonderwall with 316 outbound targets).
//   - Rate-weighted pruning: at hop 2+, edges carrying < 1% of the parent's
//     entry rate are dropped as likely unrelated to the focus service.
func (a *App) queryServiceMapMultiHop(
	ctx context.Context,
	from, to time.Time,
	filterService, _, filterEnvironment string,
	depth int,
) ServiceMapResponse {
	logger := log.DefaultLogger.With("handler", "servicemap-multihop", "service", sanitizeLogValue(filterService), "depth", depth)
	baseLabelFilter := envMatcher(a.otelCfg.Labels.DeploymentEnv, filterEnvironment)

	hop1Edges := a.queryServiceGraphEdgesScoped(ctx, from, to, baseLabelFilter, filterService)
	logger.Info("Hop 1 complete", "edges", len(hop1Edges))

	s := initBFSState(filterService, hop1Edges)

	for hop := 2; hop <= depth; hop++ {
		candidates := s.buildCandidates()
		if len(candidates) == 0 {
			logger.Info("BFS terminated early, no candidates", "hop", hop)
			break
		}

		candidateNames := make([]string, len(candidates))
		for i, c := range candidates {
			candidateNames[i] = normalizeServiceName(c.name)
		}
		outDegree, inDegree := a.queryNodeDegrees(ctx, to, baseLabelFilter, candidateNames)

		frontier := s.filterHubs(candidates, outDegree, inDegree)
		if len(frontier) == 0 {
			logger.Info("BFS terminated, all candidates are hubs or infra", "hop", hop)
			break
		}

		sort.Slice(frontier, func(i, j int) bool { return frontier[i].rate > frontier[j].rate })
		if len(frontier) > maxFrontierSize {
			for _, f := range frontier[maxFrontierSize:] {
				s.seen[f.name] = false
			}
			frontier = frontier[:maxFrontierSize]
		}

		outNames, inNames := s.splitFrontier(frontier)
		if len(outNames) == 0 && len(inNames) == 0 {
			logger.Info("BFS terminated, no valid frontier after normalization", "hop", hop)
			break
		}
		logger.Info("Expanding frontier", "hop", hop, "outbound", len(outNames), "inbound", len(inNames), "hubs", len(s.hubNodes))

		if len(outNames) > 0 {
			outEdges := a.queryServiceGraphEdgesDirected(ctx, from, to, baseLabelFilter, outNames, true)
			added := s.mergeEdgesWithPruning(outEdges, true)
			logger.Info("Outbound expansion", "hop", hop, "queried", len(outEdges), "kept", added)
		}
		if len(inNames) > 0 {
			inEdges := a.queryServiceGraphEdgesDirected(ctx, from, to, baseLabelFilter, inNames, false)
			added := s.mergeEdgesWithPruning(inEdges, false)
			logger.Info("Inbound expansion", "hop", hop, "queried", len(inEdges), "kept", added)
		}
	}

	logger.Info("BFS complete", "totalEdges", len(s.allEdges), "hubs", len(s.hubNodes))
	return assembleServiceMapResponseWithHubs(s.allEdges, s.hubNodes)
}
// when service graph metrics are unavailable (e.g., environments without the
// Tempo service graph processor). It queries calls_total with server_address and
// http_host labels to find outbound and inbound connections.
func (a *App) querySpanmetricsTopologyFallback(
	ctx context.Context, from, to time.Time, baseLabelFilter, service string,
	needOutbound, needInbound bool,
) map[sgEdgeKey]*sgEdgeData {
	logger := log.DefaultLogger.With("handler", "servicegraph-sm-fallback", "service", sanitizeLogValue(service))
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

		// Ingress alias supplement: also find callers via configured ingress hostnames.
		for _, hostname := range a.ingressHostnames(service) {
			escapedHost := promQLEscape(hostname)
			inRateQ += fmt.Sprintf(
				` or sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s(:[0-9]+)?"%s}%s))`,
				cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
				callsMetric, cfg.Labels.SpanKind, cfg.SpanKinds.Client,
				cfg.Labels.ServerAddress, escapedHost, envFilter, rangeStr,
			)
			inErrQ += fmt.Sprintf(
				` or sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s(:[0-9]+)?", %s="%s"%s}%s))`,
				cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
				callsMetric, cfg.Labels.SpanKind, cfg.SpanKinds.Client,
				cfg.Labels.ServerAddress, escapedHost,
				cfg.Labels.StatusCode, cfg.StatusCodes.Error, envFilter, rangeStr,
			)
		}

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
			serverName := a.resolveIngressAlias(extractTopologyNodeName(addr))
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
			serverName := a.resolveIngressAlias(extractTopologyNodeName(addr))
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

// resolveIngressAlias checks if the given address is a known ingress alias
// and returns the mapped service name if so. Otherwise returns the original name.
func (a *App) resolveIngressAlias(name string) string {
	if a.settings.IngressAliases == nil {
		return name
	}
	// Try the name as-is (e.g., "tilgangsmaskin.intern.nav.no")
	if svc, ok := a.settings.IngressAliases[name]; ok {
		return svc
	}
	return name
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
// preprocessServiceMapEdges splits self-loop infrastructure edges into synthetic nodes
// and normalizes K8s FQDN names to short service names.
func preprocessServiceMapEdges(edges map[sgEdgeKey]*sgEdgeData) map[sgEdgeKey]*sgEdgeData {
	// Split self-loop edges with infrastructure types into separate nodes.
	// When client=server with connection_type=database/messaging, the server represents
	// a local resource (e.g., the service's own database), not the service itself.
	selfLoopSplits := make(map[sgEdgeKey]*sgEdgeData)
	var selfLoopKeys []sgEdgeKey
	for k, e := range edges {
		if k.client == k.server && (e.connType == "database" || e.connType == "messaging_system") {
			selfLoopKeys = append(selfLoopKeys, k)
			suffix := e.dbSystem
			if suffix == "" {
				suffix = e.messagingSystem
			}
			if suffix == "" {
				suffix = e.connType
			}
			selfLoopSplits[sgEdgeKey{client: k.client, server: k.server + "__" + suffix}] = e
		}
	}
	for _, k := range selfLoopKeys {
		delete(edges, k)
	}
	for k, e := range selfLoopSplits {
		edges[k] = e
	}

	// Normalize K8s FQDN names to short service names
	normalized := make(map[sgEdgeKey]*sgEdgeData, len(edges))
	for k, e := range edges {
		nk := sgEdgeKey{
			client: stripHexSuffix(normalizeServiceName(k.client)),
			server: stripHexSuffix(normalizeServiceName(k.server)),
		}
		if nk.client == nk.server {
			continue // skip self-loops created by normalization
		}
		if existing, ok := normalized[nk]; ok {
			existing.rate += e.rate
			existing.errorRate += e.errorRate
			if e.p95 > existing.p95 {
				existing.p95 = e.p95
			}
			if existing.connType == "" {
				existing.connType = e.connType
			}
			if existing.dbSystem == "" {
				existing.dbSystem = e.dbSystem
			}
			if existing.messagingSystem == "" {
				existing.messagingSystem = e.messagingSystem
			}
		} else {
			normalized[nk] = &sgEdgeData{
				rate:            e.rate,
				errorRate:       e.errorRate,
				p95:             e.p95,
				connType:        e.connType,
				dbSystem:        e.dbSystem,
				messagingSystem: e.messagingSystem,
			}
		}
	}
	return normalized
}

func assembleServiceMapResponse(edges map[sgEdgeKey]*sgEdgeData) ServiceMapResponse {
	edges = preprocessServiceMapEdges(edges)

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
	callerCounts := make(map[string]map[string]bool) // server → set of callers
	for k, e := range edges {
		// Track unique callers per server for callerCount
		if _, ok := callerCounts[k.server]; !ok {
			callerCounts[k.server] = make(map[string]bool)
		}
		callerCounts[k.server][k.client] = true

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

		// For synthetic infra nodes (kiss__postgresql), use the original name as title
		title := name
		if idx := strings.Index(name, "__"); idx != -1 && (nType == "database" || nType == "messaging") {
			title = name[:idx]
		}

		nodes = append(nodes, ServiceMapNode{
			ID:            name,
			Title:         title,
			SubTitle:      nodeSubtitles[name],
			MainStat:      fmt.Sprintf("%.1f req/s", totalRate),
			SecondaryStat: fmt.Sprintf("%.1f%% errors", errPct*100),
			ArcErrors:     errPct,
			ArcOK:         1 - errPct,
			NodeType:      nType,
			IsSidecar:     isSidecar(name),
			CallerCount:   len(callerCounts[name]),
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

// assembleServiceMapResponseWithHubs wraps assembleServiceMapResponse and
// annotates hub nodes (high-degree shared infrastructure) so the frontend
// can render them distinctively.
func assembleServiceMapResponseWithHubs(edges map[sgEdgeKey]*sgEdgeData, hubs map[string]int) ServiceMapResponse {
	resp := assembleServiceMapResponse(edges)
	if len(hubs) == 0 {
		return resp
	}
	// Also check normalized names since edges go through normalization
	normalizedHubs := make(map[string]int, len(hubs))
	for name, degree := range hubs {
		normalizedHubs[normalizeServiceName(name)] = degree
	}
	for i := range resp.Nodes {
		if degree, ok := normalizedHubs[resp.Nodes[i].ID]; ok {
			resp.Nodes[i].IsHub = true
			resp.Nodes[i].HubDegree = degree
		}
	}
	return resp
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

// debugServiceMapMultiHop runs the direction-aware BFS with diagnostic output,
// including hub detection and rate-weighted pruning info.
func (a *App) debugServiceMapMultiHop(
	ctx context.Context, from, to time.Time,
	filterService, filterEnvironment string, depth int,
) interface{} {
	baseLabelFilter := envMatcher(a.otelCfg.Labels.DeploymentEnv, filterEnvironment)
	allEdges := a.queryServiceGraphEdgesScoped(ctx, from, to, baseLabelFilter, filterService)

	hop1Edges := make(map[string]string, len(allEdges))
	for k, e := range allEdges {
		hop1Edges[k.client+" -> "+k.server] = fmt.Sprintf("rate=%.3f ct=%q", e.rate, e.connType)
	}

	s := initBFSState(filterService, allEdges)

	type hopDebug struct {
		Hop          int               `json:"hop"`
		OutNames     []string          `json:"outboundFrontier"`
		InNames      []string          `json:"inboundFrontier"`
		HubsDetected map[string]int    `json:"hubsDetected"`
		OutEdges     int               `json:"outboundEdgesQueried"`
		InEdges      int               `json:"inboundEdgesQueried"`
		OutKept      int               `json:"outboundEdgesKept"`
		InKept       int               `json:"inboundEdgesKept"`
		SampleEdges  map[string]string `json:"sampleEdges"`
	}
	var hops []hopDebug

	for hop := 2; hop <= depth; hop++ {
		candidates := s.buildCandidates()
		candidateNames := make([]string, len(candidates))
		for i, c := range candidates {
			candidateNames[i] = normalizeServiceName(c.name)
		}
		outDegree, inDegree := a.queryNodeDegrees(ctx, to, baseLabelFilter, candidateNames)

		// Record which ones are hubs before filtering
		preHubs := make(map[string]int)
		for _, c := range candidates {
			n := normalizeServiceName(c.name)
			dirDeg := outDegree[n]
			if c.dir == bfsDirInbound {
				dirDeg = inDegree[n]
			}
			if dirDeg >= hubDegreeThreshold {
				preHubs[c.name] = dirDeg
			}
		}

		frontier := s.filterHubs(candidates, outDegree, inDegree)
		sort.Slice(frontier, func(i, j int) bool { return frontier[i].rate > frontier[j].rate })
		if len(frontier) > maxFrontierSize {
			frontier = frontier[:maxFrontierSize]
		}
		outNames, inNames := s.splitFrontier(frontier)

		var outEdges, inEdges map[sgEdgeKey]*sgEdgeData
		if len(outNames) > 0 {
			outEdges = a.queryServiceGraphEdgesDirected(ctx, from, to, baseLabelFilter, outNames, true)
		}
		if len(inNames) > 0 {
			inEdges = a.queryServiceGraphEdgesDirected(ctx, from, to, baseLabelFilter, inNames, false)
		}

		outKept := s.mergeEdgesWithPruning(outEdges, true)
		inKept := s.mergeEdgesWithPruning(inEdges, false)

		sampleEdges := make(map[string]string)
		i := 0
		for k, e := range outEdges {
			if i >= 10 {
				break
			}
			sampleEdges[k.client+" -> "+k.server] = fmt.Sprintf("rate=%.3f (out)", e.rate)
			i++
		}

		hops = append(hops, hopDebug{
			Hop:          hop,
			OutNames:     outNames,
			InNames:      inNames,
			HubsDetected: preHubs,
			OutEdges:     len(outEdges),
			InEdges:      len(inEdges),
			OutKept:      outKept,
			InKept:       inKept,
			SampleEdges:  sampleEdges,
		})
	}

	return map[string]interface{}{
		"service":         filterService,
		"environment":     filterEnvironment,
		"baseLabelFilter": baseLabelFilter,
		"hop1EdgeCount":   len(hop1Edges),
		"hop1Edges":       hop1Edges,
		"hops":            hops,
		"debug":           true,
	}
}
