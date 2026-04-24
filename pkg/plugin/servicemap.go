package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
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

	// Check response cache
	roundedFrom := fmt.Sprintf("%d", from.Unix()/30*30)
	roundedTo := fmt.Sprintf("%d", to.Unix()/30*30)
	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("servicemap", orgID, roundedFrom, roundedTo, filterService, filterNamespace, filterEnvironment)
	if cached, ok := a.respCache.get(ck); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Cache", "HIT")
		_, _ = w.Write(cached)
		return
	}

	graph := a.queryServiceMap(ctx, from, to, filterService, filterNamespace, filterEnvironment)

	a.respCache.setJSON(ck, graph)
	writeJSON(w, graph)
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
func (a *App) queryServiceGraphEdges(ctx context.Context, to time.Time, filterEnv string) map[sgEdgeKey]*sgEdgeData {
	logger := log.DefaultLogger.With("handler", "servicegraph")
	rangeStr := "[5m]"
	sgp := a.serviceGraphPrefix()

	labelFilter := ""
	if filterEnv != "" {
		labelFilter = fmt.Sprintf(`%s="%s"`, a.otelCfg.Labels.DeploymentEnv, filterEnv)
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

func (a *App) queryServiceMap( //nolint:gocyclo // complex due to filtering + node/edge assembly
	ctx context.Context,
	_, to time.Time,
	filterService, filterNamespace, filterEnvironment string,
) ServiceMapResponse {
	// Pass the environment filter to service graph edge queries so that only
	// edges matching the selected environment are included. At Nav the
	// deployment label (k8s_cluster_name) is a resource label present on all
	// metrics including Tempo service graph metrics.
	edges := a.queryServiceGraphEdges(ctx, to, filterEnvironment)

	nodeSet := make(map[string]bool)
	for k := range edges {
		nodeSet[k.client] = true
		nodeSet[k.server] = true
	}

	// Apply per-service filter if specified
	if filterService != "" {
		filtered := make(map[sgEdgeKey]*sgEdgeData)
		filteredNodes := make(map[string]bool)
		for k, e := range edges {
			if k.client == filterService || k.server == filterService {
				filtered[k] = e
				filteredNodes[k.client] = true
				filteredNodes[k.server] = true
			}
		}
		edges = filtered
		nodeSet = filteredNodes
	}

	// Apply namespace filter: keep edges where at least one end belongs to the namespace.
	// Service graph metrics lack namespace labels, so we build a name→namespace mapping
	// from spanmetrics (which DO carry service_namespace).
	if filterNamespace != "" {
		nsMap := a.buildServiceNamespaceMap(ctx, to, filterEnvironment)
		filtered := make(map[sgEdgeKey]*sgEdgeData)
		filteredNodes := make(map[string]bool)
		for k, e := range edges {
			if nsMap[k.client] == filterNamespace || nsMap[k.server] == filterNamespace {
				filtered[k] = e
				filteredNodes[k.client] = true
				filteredNodes[k.server] = true
			}
		}
		edges = filtered
		nodeSet = filteredNodes
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
	if filterEnv != "" {
		envFilter = fmt.Sprintf(`, %s="%s"`, a.otelCfg.Labels.DeploymentEnv, filterEnv)
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
