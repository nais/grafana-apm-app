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
	service := req.PathValue("service")
	// namespace := req.PathValue("namespace")

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.ServiceGraph.Detected {
		writeJSON(w, DependenciesResponse{Dependencies: []DependencySummary{}})
		return
	}

	now := time.Now()
	to := parseUnixParam(req, "to", now)

	deps := a.queryDependencies(ctx, to, service, "")
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

	deps := a.queryDependencies(ctx, to, "", "")
	writeJSON(w, DependenciesResponse{Dependencies: deps})
}

// handleDependencyDetail returns RED metrics and upstream services for a specific dependency.
// GET /dependencies/{name}?from=&to=
func (a *App) handleDependencyDetail(w http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	depName := req.PathValue("name")

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.ServiceGraph.Detected {
		writeJSON(w, map[string]interface{}{
			"dependency": DependencySummary{Name: depName},
			"upstreams":  []DependencySummary{},
		})
		return
	}

	now := time.Now()
	to := parseUnixParam(req, "to", now)

	detail := a.queryDependencyDetail(ctx, to, depName)
	writeJSON(w, detail)
}

// DependencyDetailResponse contains dependency info plus upstream callers.
type DependencyDetailResponse struct {
	Dependency DependencySummary   `json:"dependency"`
	Upstreams  []DependencySummary `json:"upstreams"`
}

// queryDependencies queries servicegraph metrics for dependencies.
// If filterClient is set, only returns dependencies called by that service.
func (a *App) queryDependencies(
	ctx context.Context,
	to time.Time,
	filterClient string,
	filterServer string,
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

	// Build response
	result := make([]DependencySummary, 0, len(deps))
	for name, d := range deps {
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

// queryDependencyDetail returns RED metrics + upstream callers for a dependency.
func (a *App) queryDependencyDetail(
	ctx context.Context,
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

	return DependencyDetailResponse{
		Dependency: DependencySummary{
			Name:         depName,
			Type:         inferDependencyType(depName, ""),
			Rate:         roundTo(totalRate, 3),
			ErrorRate:    roundTo(errPct, 2),
			P95Duration:  roundTo(totalP95*1000, 2),
			DurationUnit: "ms",
		},
		Upstreams: upstreamList,
	}
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
