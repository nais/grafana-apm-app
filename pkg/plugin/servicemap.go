package plugin

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// ServiceMapNode represents a node in the service map.
type ServiceMapNode struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	SubTitle  string  `json:"subtitle,omitempty"`
	MainStat  string  `json:"mainStat,omitempty"`
	SecondaryStat string `json:"secondaryStat,omitempty"`
	Arc__errors float64 `json:"arc__errors"`
	Arc__ok     float64 `json:"arc__ok"`
}

// ServiceMapEdge represents an edge between two services.
type ServiceMapEdge struct {
	ID            string  `json:"id"`
	Source        string  `json:"source"`
	Target        string  `json:"target"`
	MainStat      string  `json:"mainStat,omitempty"`
	SecondaryStat string  `json:"secondaryStat,omitempty"`
}

// ServiceMapResponse is the full service map graph.
type ServiceMapResponse struct {
	Nodes []ServiceMapNode `json:"nodes"`
	Edges []ServiceMapEdge `json:"edges"`
}

func (a *App) handleServiceMap(w http.ResponseWriter, req *http.Request) {
	ctx := req.Context()

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

	graph := a.queryServiceMap(ctx, from, to, filterService, filterNamespace)
	writeJSON(w, graph)
}

func (a *App) queryServiceMap(
	ctx context.Context,
	from, to time.Time,
	filterService, filterNamespace string,
) ServiceMapResponse {
	logger := log.DefaultLogger.With("handler", "servicemap")
	rangeStr := "[5m]"

	// Build optional label filter for per-service view
	labelFilter := ""
	if filterNamespace != "" {
		labelFilter = fmt.Sprintf(`client_service_namespace="%s"`, filterNamespace)
	}

	// Service graph metrics
	rateQuery := fmt.Sprintf(
		`sum by (client, server, connection_type) (rate(traces_service_graph_request_total%s%s))`,
		labelFilterStr(labelFilter), rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (client, server, connection_type) (rate(traces_service_graph_request_failed_total%s%s))`,
		labelFilterStr(labelFilter), rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (client, server, le) (rate(traces_service_graph_request_server_seconds_bucket%s%s)))`,
		labelFilterStr(labelFilter), rangeStr,
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
			logger.Warn("Service map query failed", "query", r.name, "error", r.err)
			continue
		}
		resultMap[r.name] = r.results
	}

	// Build edge map keyed by client->server
	type edgeKey struct {
		client string
		server string
	}
	type edgeData struct {
		rate      float64
		errorRate float64
		p95       float64
		connType  string
	}

	edges := make(map[edgeKey]*edgeData)
	nodeSet := make(map[string]bool)

	getEdge := func(client, server string) *edgeData {
		k := edgeKey{client, server}
		if e, ok := edges[k]; ok {
			return e
		}
		e := &edgeData{}
		edges[k] = e
		nodeSet[client] = true
		nodeSet[server] = true
		return e
	}

	for _, r := range resultMap["rate"] {
		client := r.Metric["client"]
		server := r.Metric["server"]
		if client == "" || server == "" {
			continue
		}
		e := getEdge(client, server)
		e.rate = r.Value.Float()
		e.connType = r.Metric["connection_type"]
	}

	for _, r := range resultMap["error"] {
		client := r.Metric["client"]
		server := r.Metric["server"]
		if client == "" || server == "" {
			continue
		}
		e := getEdge(client, server)
		e.errorRate = r.Value.Float()
	}

	for _, r := range resultMap["p95"] {
		client := r.Metric["client"]
		server := r.Metric["server"]
		if client == "" || server == "" {
			continue
		}
		e := getEdge(client, server)
		v := r.Value.Float()
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			e.p95 = v
		}
	}

	// Apply per-service filter if specified
	if filterService != "" {
		filtered := make(map[edgeKey]*edgeData)
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

	// Calculate per-node aggregate error rates for arc display
	type nodeAgg struct {
		totalRate float64
		errorRate float64
	}
	nodeAggs := make(map[string]*nodeAgg)
	for k, e := range edges {
		for _, n := range []string{k.client, k.server} {
			agg, ok := nodeAggs[n]
			if !ok {
				agg = &nodeAgg{}
				nodeAggs[n] = agg
			}
			agg.totalRate += e.rate
			agg.errorRate += e.errorRate
		}
	}

	// Build response
	var nodes []ServiceMapNode
	for name := range nodeSet {
		agg := nodeAggs[name]
		errPct := 0.0
		if agg != nil && agg.totalRate > 0 {
			errPct = agg.errorRate / agg.totalRate
		}
		nodes = append(nodes, ServiceMapNode{
			ID:            name,
			Title:         name,
			MainStat:      fmt.Sprintf("%.1f req/s", agg.totalRate),
			SecondaryStat: fmt.Sprintf("%.1f%% errors", errPct*100),
			Arc__errors:   errPct,
			Arc__ok:       1 - errPct,
		})
	}

	var edgeList []ServiceMapEdge
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

	if nodes == nil {
		nodes = []ServiceMapNode{}
	}
	if edgeList == nil {
		edgeList = []ServiceMapEdge{}
	}

	return ServiceMapResponse{Nodes: nodes, Edges: edgeList}
}

func labelFilterStr(filter string) string {
	if filter == "" {
		return ""
	}
	return "{" + filter + "}"
}
