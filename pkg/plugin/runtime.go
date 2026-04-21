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

func (a *App) handleRuntime(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := req.Context()
	ctx = withAuthContext(ctx, a.promClientForRequest(req))

	namespace := queries.MustSanitizeLabel(req.PathValue("namespace"))
	service := queries.MustSanitizeLabel(req.PathValue("service"))
	if !requireServiceParam(w, service) {
		return
	}

	now := time.Now()
	_ = parseUnixParam(req, "from", now.Add(-1*time.Hour))
	to := parseUnixParam(req, "to", now)

	result := a.queryRuntimeMetrics(ctx, namespace, service, to)
	writeJSON(w, result)
}

// queryRuntimeMetrics runs a single discovery query to find available runtime
// metrics, then fans out parallel queries for each detected category.
func (a *App) queryRuntimeMetrics(ctx context.Context, namespace, service string, at time.Time) queries.RuntimeResponse {
	logger := log.DefaultLogger.With("handler", "runtime")
	client := a.prom(ctx)
	if client == nil {
		return queries.RuntimeResponse{}
	}

	rt := a.otelCfg.Runtime
	svcFilter := a.otelCfg.RuntimeFilter(service, namespace)

	// Single discovery query: find all runtime metric families for this service.
	discoveryQuery := fmt.Sprintf(
		`count by (__name__) ({%s, __name__=~"jvm_.*|nodejs_.*|hikaricp_.*|db_client_connections_.*|kafka_consumer_.*|kafka_producer_.*|process_.*|system_.*|go_.*"})`,
		svcFilter,
	)
	results, err := client.InstantQuery(ctx, discoveryQuery, at)
	if err != nil {
		logger.Warn("runtime discovery query failed", "error", err)
		return queries.RuntimeResponse{}
	}

	discovered := make(map[string]bool, len(results))
	for _, r := range results {
		if name := r.Metric["__name__"]; name != "" {
			discovered[name] = true
		}
	}

	if len(discovered) == 0 {
		return queries.RuntimeResponse{}
	}

	var resp queries.RuntimeResponse
	var mu sync.Mutex
	var wg sync.WaitGroup
	// Limit concurrent runtime categories to avoid overwhelming Mimir.
	// Each category fires 4-22 parallel queries internally; capping at 3
	// concurrent categories keeps peak query concurrency around 30.
	catSem := make(chan struct{}, 3)

	// JVM
	if discovered[rt.JVM.MemoryUsed] || discovered[rt.JVM.ThreadsLive] || discovered[rt.JVM.Info] {
		wg.Add(1)
		go func() {
			catSem <- struct{}{}
			defer func() { <-catSem }()
			defer wg.Done()
			jvm := a.queryJVMRuntime(ctx, client, svcFilter, at, logger)
			mu.Lock()
			resp.JVM = jvm
			mu.Unlock()
		}()
	}

	// Node.js
	if discovered[rt.NodeJS.HeapUsed] || discovered[rt.NodeJS.EventLoopP99] || discovered[rt.NodeJS.VersionInfo] {
		wg.Add(1)
		go func() {
			catSem <- struct{}{}
			defer func() { <-catSem }()
			defer wg.Done()
			nodejs := a.queryNodeJSRuntime(ctx, client, svcFilter, at, logger)
			mu.Lock()
			resp.NodeJS = nodejs
			mu.Unlock()
		}()
	}

	// DB Pool
	if discovered[rt.DBPool.HikariActive] || discovered[rt.DBPool.OtelDBActive] {
		wg.Add(1)
		go func() {
			catSem <- struct{}{}
			defer func() { <-catSem }()
			defer wg.Done()
			dbPool := a.queryDBPoolRuntime(ctx, client, svcFilter, at, logger)
			mu.Lock()
			resp.DBPool = dbPool
			mu.Unlock()
		}()
	}

	// Kafka
	if discovered[rt.Kafka.ConsumerLagMax] || discovered[rt.Kafka.ConsumerConsumed] || discovered[rt.Kafka.ProducerSent] {
		wg.Add(1)
		go func() {
			catSem <- struct{}{}
			defer func() { <-catSem }()
			defer wg.Done()
			kafka := a.queryKafkaRuntime(ctx, client, svcFilter, at, logger)
			mu.Lock()
			resp.Kafka = kafka
			mu.Unlock()
		}()
	}

	// Go runtime
	if discovered[rt.Go.Goroutines] || discovered[rt.Go.MemAlloc] {
		wg.Add(1)
		go func() {
			catSem <- struct{}{}
			defer func() { <-catSem }()
			defer wg.Done()
			goRt := a.queryGoRuntime(ctx, client, svcFilter, at, logger)
			mu.Lock()
			resp.Go = goRt
			mu.Unlock()
		}()
	}

	// Container resource metrics (separate filter — uses container/namespace, not app)
	ctrFilter := a.otelCfg.ContainerFilter(service, namespace)
	wg.Add(1)
	go func() {
		catSem <- struct{}{}
		defer func() { <-catSem }()
		defer wg.Done()
		ctr := a.queryContainerRuntime(ctx, client, ctrFilter, service, namespace, at, logger)
		if ctr != nil {
			mu.Lock()
			resp.Container = ctr
			mu.Unlock()
		}
	}()

	wg.Wait()
	return resp
}

// ---------------------------------------------------------------------------
// JVM metrics
// ---------------------------------------------------------------------------

func (a *App) queryJVMRuntime( //nolint:gocyclo // many independent metric queries are inherently branchy
	ctx context.Context, client *queries.PrometheusClient,
	svcFilter string, at time.Time, logger log.Logger,
) *queries.JVMRuntime {
	rt := a.otelCfg.Runtime.JVM
	lookback := "[5m]"

	type qr struct {
		name    string
		results []queries.PromResult
	}

	querySpecs := []struct {
		name  string
		query string
	}{
		// Memory: avg across pods, grouped by area
		{"memUsed", fmt.Sprintf(`avg by (%s) (avg_over_time(%s{%s}%s))`, rt.AreaLabel, rt.MemoryUsed, svcFilter, lookback)},
		{"memMax", fmt.Sprintf(`max by (%s) (max_over_time(%s{%s}%s))`, rt.AreaLabel, rt.MemoryMax, svcFilter, lookback)},
		{"memCommitted", fmt.Sprintf(`avg by (%s) (avg_over_time(%s{%s}%s))`, rt.AreaLabel, rt.MemoryCommitted, svcFilter, lookback)},
		// GC: rate across all pods and GC types
		{"gcCount", fmt.Sprintf(`sum(rate(%s_count{%s}%s))`, rt.GCDuration, svcFilter, lookback)},
		{"gcSum", fmt.Sprintf(`sum(rate(%s_sum{%s}%s))`, rt.GCDuration, svcFilter, lookback)},
		{"gcOverhead", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.GCOverhead, svcFilter, lookback)},
		// Threads: avg across pods
		{"threadsLive", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.ThreadsLive, svcFilter, lookback)},
		{"threadsDaemon", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.ThreadsDaemon, svcFilter, lookback)},
		{"threadsPeak", fmt.Sprintf(`max(max_over_time(%s{%s}%s))`, rt.ThreadsPeak, svcFilter, lookback)},
		{"threadStates", fmt.Sprintf(`avg by (%s) (avg_over_time(%s{%s}%s))`, rt.StateLabel, rt.ThreadsStates, svcFilter, lookback)},
		// Classes
		{"classesLoaded", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.ClassesLoaded, svcFilter, lookback)},
		// CPU
		{"cpuUtil", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.CPUUtilization, svcFilter, lookback)},
		{"cpuCount", fmt.Sprintf(`max(%s{%s})`, rt.CPUCount, svcFilter)},
		// Uptime: min across pods (shortest-running pod)
		{"uptime", fmt.Sprintf(`min(%s{%s})`, rt.Uptime, svcFilter)},
		// Buffer pools
		{"bufferUsed", fmt.Sprintf(`sum(avg_over_time(%s{%s}%s))`, rt.BufferUsed, svcFilter, lookback)},
		{"bufferCapacity", fmt.Sprintf(`sum(max_over_time(%s{%s}%s))`, rt.BufferCapacity, svcFilter, lookback)},
		// Pod count (from any JVM metric)
		{"podCount", fmt.Sprintf(`count(%s{%s, %s="heap"})`, rt.MemoryUsed, svcFilter, rt.AreaLabel)},
		// Version info
		{"info", fmt.Sprintf(`count by (runtime, version) (%s{%s})`, rt.Info, svcFilter)},
		// Memory pool breakdown: group by area + pool id
		{"poolUsed", fmt.Sprintf(`avg by (%s, %s) (avg_over_time(%s{%s}%s))`, rt.AreaLabel, rt.IDLabel, rt.MemoryUsed, svcFilter, lookback)},
		{"poolMax", fmt.Sprintf(`max by (%s, %s) (max_over_time(%s{%s}%s))`, rt.AreaLabel, rt.IDLabel, rt.MemoryMax, svcFilter, lookback)},
		// GC by type: rate and sum grouped by gc name
		{"gcByTypeCount", fmt.Sprintf(`sum by (%s) (rate(%s_count{%s}%s))`, rt.GCLabel, rt.GCDuration, svcFilter, lookback)},
		{"gcByTypeSum", fmt.Sprintf(`sum by (%s) (rate(%s_sum{%s}%s))`, rt.GCLabel, rt.GCDuration, svcFilter, lookback)},
		// GC P99 pause per type from histogram
		{"gcP99", fmt.Sprintf(`histogram_quantile(0.99, sum by (%s, le) (rate(%s_bucket{%s}%s)))`, rt.GCLabel, rt.GCDuration, svcFilter, lookback)},
	}

	var wg sync.WaitGroup
	ch := make(chan qr, len(querySpecs))

	for _, q := range querySpecs {
		wg.Add(1)
		go func(name, query string) {
			defer wg.Done()
			results, err := client.InstantQuery(ctx, query, at)
			if err != nil {
				logger.Debug("JVM query failed", "name", name, "error", err)
				return
			}
			ch <- qr{name, results}
		}(q.name, q.query)
	}
	go func() { wg.Wait(); close(ch) }()

	jvm := &queries.JVMRuntime{Status: queries.StatusDetected}
	resultMap := make(map[string][]queries.PromResult)
	for r := range ch {
		resultMap[r.name] = r.results
	}

	// Memory by area
	for _, r := range resultMap["memUsed"] {
		v := safeFloat(r.Value.Float())
		switch r.Metric["area"] {
		case "heap":
			jvm.HeapUsed = v
		case "nonheap":
			jvm.NonHeapUsed = v
		}
	}
	for _, r := range resultMap["memMax"] {
		if r.Metric["area"] == "heap" {
			jvm.HeapMax = safeFloat(r.Value.Float())
		}
	}
	for _, r := range resultMap["memCommitted"] {
		if r.Metric["area"] == "heap" {
			jvm.HeapCommitted = safeFloat(r.Value.Float())
		}
	}

	// GC
	if rs := resultMap["gcCount"]; len(rs) > 0 {
		jvm.GCPauseRate = roundTo(safeFloat(rs[0].Value.Float()), 3)
	}
	if countRs, sumRs := resultMap["gcCount"], resultMap["gcSum"]; len(countRs) > 0 && len(sumRs) > 0 {
		count := safeFloat(countRs[0].Value.Float())
		sum := safeFloat(sumRs[0].Value.Float())
		if count > 0 {
			jvm.GCPauseAvg = roundTo(sum/count, 6)
		}
	}
	if rs := resultMap["gcOverhead"]; len(rs) > 0 {
		jvm.GCOverhead = roundTo(safeFloat(rs[0].Value.Float()), 4)
	}

	// Threads
	if rs := resultMap["threadsLive"]; len(rs) > 0 {
		jvm.ThreadsLive = roundTo(safeFloat(rs[0].Value.Float()), 0)
	}
	if rs := resultMap["threadsDaemon"]; len(rs) > 0 {
		jvm.ThreadsDaemon = roundTo(safeFloat(rs[0].Value.Float()), 0)
	}
	if rs := resultMap["threadsPeak"]; len(rs) > 0 {
		jvm.ThreadsPeak = roundTo(safeFloat(rs[0].Value.Float()), 0)
	}
	// Thread states breakdown
	for _, r := range resultMap["threadStates"] {
		state := r.Metric[rt.StateLabel]
		if state == "" {
			continue
		}
		count := int(safeFloat(r.Value.Float()))
		if count > 0 {
			if jvm.ThreadStates == nil {
				jvm.ThreadStates = make(map[string]int)
			}
			jvm.ThreadStates[state] = count
		}
	}

	// Classes
	if rs := resultMap["classesLoaded"]; len(rs) > 0 {
		jvm.ClassesLoaded = roundTo(safeFloat(rs[0].Value.Float()), 0)
	}

	// CPU
	if rs := resultMap["cpuUtil"]; len(rs) > 0 {
		jvm.CPUUtilization = roundTo(safeFloat(rs[0].Value.Float()), 4)
	}
	if rs := resultMap["cpuCount"]; len(rs) > 0 {
		jvm.CPUCount = int(safeFloat(rs[0].Value.Float()))
	}

	// Uptime
	if rs := resultMap["uptime"]; len(rs) > 0 {
		jvm.Uptime = safeFloat(rs[0].Value.Float())
	}

	// Buffer pools
	if rs := resultMap["bufferUsed"]; len(rs) > 0 {
		jvm.BufferUsed = safeFloat(rs[0].Value.Float())
	}
	if rs := resultMap["bufferCapacity"]; len(rs) > 0 {
		jvm.BufferCapacity = safeFloat(rs[0].Value.Float())
	}

	// Pod count
	if rs := resultMap["podCount"]; len(rs) > 0 {
		jvm.PodCount = int(safeFloat(rs[0].Value.Float()))
	}

	// Versions
	for _, r := range resultMap["info"] {
		count := int(safeFloat(r.Value.Float()))
		if count > 0 {
			jvm.Versions = append(jvm.Versions, queries.RuntimeVersion{
				Version: r.Metric["version"],
				Runtime: r.Metric["runtime"],
				Count:   count,
			})
		}
	}
	sort.Slice(jvm.Versions, func(i, j int) bool {
		return jvm.Versions[i].Count > jvm.Versions[j].Count
	})

	// Memory pool breakdown
	for _, r := range resultMap["poolUsed"] {
		pool := r.Metric[rt.IDLabel]
		if pool == "" {
			continue
		}
		mp := queries.MemoryPool{
			Name: pool,
			Area: r.Metric[rt.AreaLabel],
			Used: safeFloat(r.Value.Float()),
		}
		// Find matching max
		for _, mr := range resultMap["poolMax"] {
			if mr.Metric[rt.IDLabel] == pool && mr.Metric[rt.AreaLabel] == mp.Area {
				v := safeFloat(mr.Value.Float())
				if v > 0 && v < 1e18 { // -1 means unbounded in JVM
					mp.Max = v
				}
				break
			}
		}
		jvm.MemoryPools = append(jvm.MemoryPools, mp)
	}
	sort.Slice(jvm.MemoryPools, func(i, j int) bool {
		// Heap pools first, then by name
		if jvm.MemoryPools[i].Area != jvm.MemoryPools[j].Area {
			return jvm.MemoryPools[i].Area == "heap"
		}
		return jvm.MemoryPools[i].Name < jvm.MemoryPools[j].Name
	})

	// GC by type
	gcCountByType := make(map[string]float64)
	gcSumByType := make(map[string]float64)
	gcP99ByType := make(map[string]float64)
	for _, r := range resultMap["gcByTypeCount"] {
		gc := r.Metric[rt.GCLabel]
		if gc != "" {
			gcCountByType[gc] = safeFloat(r.Value.Float())
		}
	}
	for _, r := range resultMap["gcByTypeSum"] {
		gc := r.Metric[rt.GCLabel]
		if gc != "" {
			gcSumByType[gc] = safeFloat(r.Value.Float())
		}
	}
	for _, r := range resultMap["gcP99"] {
		gc := r.Metric[rt.GCLabel]
		if gc != "" {
			gcP99ByType[gc] = safeFloat(r.Value.Float())
		}
	}
	for gc, rate := range gcCountByType {
		if rate <= 0 {
			continue
		}
		gt := queries.GCType{
			Name: gc,
			Rate: roundTo(rate, 3),
		}
		if sum, ok := gcSumByType[gc]; ok && rate > 0 {
			gt.AvgPause = roundTo(sum/rate, 6)
		}
		if p99, ok := gcP99ByType[gc]; ok {
			gt.P99Pause = roundTo(p99, 6)
		}
		jvm.GCTypes = append(jvm.GCTypes, gt)
	}
	sort.Slice(jvm.GCTypes, func(i, j int) bool {
		return jvm.GCTypes[i].Rate > jvm.GCTypes[j].Rate
	})

	return jvm
}

// ---------------------------------------------------------------------------
// Node.js metrics
// ---------------------------------------------------------------------------

func (a *App) queryNodeJSRuntime(
	ctx context.Context, client *queries.PrometheusClient,
	svcFilter string, at time.Time, logger log.Logger,
) *queries.NodeJSRuntime {
	rt := a.otelCfg.Runtime.NodeJS
	lookback := "[5m]"

	type qr struct {
		name    string
		results []queries.PromResult
	}

	querySpecs := []struct {
		name  string
		query string
	}{
		// Event loop: max of p99/p90 across pods (quantile gauges — don't avg)
		{"elP99", fmt.Sprintf(`max(max_over_time(%s{%s}%s))`, rt.EventLoopP99, svcFilter, lookback)},
		{"elP90", fmt.Sprintf(`max(max_over_time(%s{%s}%s))`, rt.EventLoopP90, svcFilter, lookback)},
		{"elP50", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.EventLoopP50, svcFilter, lookback)},
		{"elMean", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.EventLoopMean, svcFilter, lookback)},
		{"elUtil", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.EventLoopUtil, svcFilter, lookback)},
		// Heap
		{"heapUsed", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.HeapUsed, svcFilter, lookback)},
		{"heapTotal", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.HeapTotal, svcFilter, lookback)},
		{"externalMem", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.ExternalMem, svcFilter, lookback)},
		{"rss", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.RSS, svcFilter, lookback)},
		// GC rate
		{"gcRate", fmt.Sprintf(`sum(rate(%s_count{%s}%s))`, rt.GCDuration, svcFilter, lookback)},
		// Active handles & requests
		{"activeHandles", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.ActiveHandles, svcFilter, lookback)},
		{"activeRequests", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.ActiveRequests, svcFilter, lookback)},
		// CPU usage (rate of counter → CPU seconds/sec)
		{"cpuRate", fmt.Sprintf(`avg(rate(%s{%s}%s))`, rt.CPUTotal, svcFilter, lookback)},
		// File descriptors
		{"openFds", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.OpenFDs, svcFilter, lookback)},
		{"maxFds", fmt.Sprintf(`max(%s{%s})`, rt.MaxFDs, svcFilter)},
		// Pod count
		{"podCount", fmt.Sprintf(`count(%s{%s})`, rt.HeapUsed, svcFilter)},
		// Version info
		{"info", fmt.Sprintf(`count by (version) (%s{%s})`, rt.VersionInfo, svcFilter)},
	}

	var wg sync.WaitGroup
	ch := make(chan qr, len(querySpecs))
	for _, q := range querySpecs {
		wg.Add(1)
		go func(name, query string) {
			defer wg.Done()
			results, err := client.InstantQuery(ctx, query, at)
			if err != nil {
				logger.Debug("Node.js query failed", "name", name, "error", err)
				return
			}
			ch <- qr{name, results}
		}(q.name, q.query)
	}
	go func() { wg.Wait(); close(ch) }()

	node := &queries.NodeJSRuntime{Status: queries.StatusDetected}
	resultMap := make(map[string][]queries.PromResult)
	for r := range ch {
		resultMap[r.name] = r.results
	}

	assignFirst := func(key string, target *float64, decimals int) {
		if rs := resultMap[key]; len(rs) > 0 {
			*target = roundTo(safeFloat(rs[0].Value.Float()), decimals)
		}
	}

	assignFirst("elP99", &node.EventLoopP99, 6)
	assignFirst("elP90", &node.EventLoopP90, 6)
	assignFirst("elP50", &node.EventLoopP50, 6)
	assignFirst("elMean", &node.EventLoopMean, 6)
	assignFirst("elUtil", &node.EventLoopUtil, 4)
	assignFirst("heapUsed", &node.HeapUsed, 0)
	assignFirst("heapTotal", &node.HeapTotal, 0)
	assignFirst("externalMem", &node.ExternalMem, 0)
	assignFirst("rss", &node.RSS, 0)
	assignFirst("gcRate", &node.GCRate, 3)
	assignFirst("activeHandles", &node.ActiveHandles, 0)
	assignFirst("activeRequests", &node.ActiveRequests, 0)
	assignFirst("cpuRate", &node.CPUUsage, 4)
	assignFirst("openFds", &node.OpenFDs, 0)
	assignFirst("maxFds", &node.MaxFDs, 0)

	if rs := resultMap["podCount"]; len(rs) > 0 {
		node.PodCount = int(safeFloat(rs[0].Value.Float()))
	}

	for _, r := range resultMap["info"] {
		count := int(safeFloat(r.Value.Float()))
		if count > 0 {
			node.Versions = append(node.Versions, queries.RuntimeVersion{
				Version: r.Metric["version"],
				Count:   count,
			})
		}
	}
	sort.Slice(node.Versions, func(i, j int) bool {
		return node.Versions[i].Count > node.Versions[j].Count
	})

	return node
}

// ---------------------------------------------------------------------------
// DB connection pool metrics
// ---------------------------------------------------------------------------

func (a *App) queryDBPoolRuntime(
	ctx context.Context, client *queries.PrometheusClient,
	svcFilter string, at time.Time, logger log.Logger,
) *queries.DBPoolRuntime {
	rt := a.otelCfg.Runtime.DBPool
	lookback := "[5m]"

	type qr struct {
		name    string
		results []queries.PromResult
	}

	querySpecs := []struct {
		name  string
		query string
	}{
		// HikariCP pools grouped by pool name: sum across pods per pool
		{"hkActive", fmt.Sprintf(`sum by (%s) (avg_over_time(%s{%s}%s))`, rt.PoolLabel, rt.HikariActive, svcFilter, lookback)},
		{"hkIdle", fmt.Sprintf(`sum by (%s) (avg_over_time(%s{%s}%s))`, rt.PoolLabel, rt.HikariIdle, svcFilter, lookback)},
		{"hkMax", fmt.Sprintf(`max by (%s) (max_over_time(%s{%s}%s))`, rt.PoolLabel, rt.HikariMax, svcFilter, lookback)},
		{"hkPending", fmt.Sprintf(`sum by (%s) (avg_over_time(%s{%s}%s))`, rt.PoolLabel, rt.HikariPending, svcFilter, lookback)},
		{"hkTimeout", fmt.Sprintf(`sum by (%s) (rate(%s{%s}%s))`, rt.PoolLabel, rt.HikariTimeout, svcFilter, lookback)},
	}

	var wg sync.WaitGroup
	ch := make(chan qr, len(querySpecs))
	for _, q := range querySpecs {
		wg.Add(1)
		go func(name, query string) {
			defer wg.Done()
			results, err := client.InstantQuery(ctx, query, at)
			if err != nil {
				logger.Debug("DB pool query failed", "name", name, "error", err)
				return
			}
			ch <- qr{name, results}
		}(q.name, q.query)
	}
	go func() { wg.Wait(); close(ch) }()

	resultMap := make(map[string][]queries.PromResult)
	for r := range ch {
		resultMap[r.name] = r.results
	}

	// Build pool map from HikariCP metrics
	poolMap := make(map[string]*queries.DBPool)
	getPool := func(name string) *queries.DBPool {
		if p, ok := poolMap[name]; ok {
			return p
		}
		p := &queries.DBPool{Name: name, Type: "hikaricp"}
		poolMap[name] = p
		return p
	}

	for _, r := range resultMap["hkActive"] {
		getPool(r.Metric[rt.PoolLabel]).Active = roundTo(safeFloat(r.Value.Float()), 1)
	}
	for _, r := range resultMap["hkIdle"] {
		getPool(r.Metric[rt.PoolLabel]).Idle = roundTo(safeFloat(r.Value.Float()), 1)
	}
	for _, r := range resultMap["hkMax"] {
		getPool(r.Metric[rt.PoolLabel]).Max = safeFloat(r.Value.Float())
	}
	for _, r := range resultMap["hkPending"] {
		getPool(r.Metric[rt.PoolLabel]).Pending = roundTo(safeFloat(r.Value.Float()), 1)
	}
	for _, r := range resultMap["hkTimeout"] {
		getPool(r.Metric[rt.PoolLabel]).TimeoutRate = roundTo(safeFloat(r.Value.Float()), 4)
	}

	// Calculate utilization
	pools := make([]queries.DBPool, 0, len(poolMap))
	for _, p := range poolMap {
		if p.Max > 0 {
			p.Utilization = roundTo(p.Active/p.Max*100, 1)
		}
		pools = append(pools, *p)
	}
	sort.Slice(pools, func(i, j int) bool { return pools[i].Name < pools[j].Name })

	if len(pools) == 0 {
		return nil
	}

	return &queries.DBPoolRuntime{
		Status: queries.StatusDetected,
		Pools:  pools,
	}
}

// ---------------------------------------------------------------------------
// Kafka consumer metrics
// ---------------------------------------------------------------------------

func (a *App) queryKafkaRuntime(
	ctx context.Context, client *queries.PrometheusClient,
	svcFilter string, at time.Time, logger log.Logger,
) *queries.KafkaRuntime {
	rt := a.otelCfg.Runtime.Kafka
	lookback := "[5m]"

	type qr struct {
		name    string
		results []queries.PromResult
	}

	querySpecs := []struct {
		name  string
		query string
	}{
		// Max lag per topic (max across partitions and pods)
		{"lag", fmt.Sprintf(
			`max by (%s) (max_over_time(%s{%s}%s))`,
			rt.TopicLabel, rt.ConsumerLagMax, svcFilter, lookback,
		)},
		// Partition count per topic
		{"partitions", fmt.Sprintf(
			`count by (%s) (%s{%s})`,
			rt.TopicLabel, rt.ConsumerLagMax, svcFilter,
		)},
		// Consume rate per topic
		{"consumed", fmt.Sprintf(
			`sum by (%s) (rate(%s{%s}%s))`,
			rt.TopicLabel, rt.ConsumerConsumed, svcFilter, lookback,
		)},
		// Producer rate per topic
		{"produced", fmt.Sprintf(
			`sum by (%s) (rate(%s{%s}%s))`,
			rt.TopicLabel, rt.ProducerSent, svcFilter, lookback,
		)},
	}

	var wg sync.WaitGroup
	ch := make(chan qr, len(querySpecs))
	for _, q := range querySpecs {
		wg.Add(1)
		go func(name, query string) {
			defer wg.Done()
			results, err := client.InstantQuery(ctx, query, at)
			if err != nil {
				logger.Debug("Kafka query failed", "name", name, "error", err)
				return
			}
			ch <- qr{name, results}
		}(q.name, q.query)
	}
	go func() { wg.Wait(); close(ch) }()

	resultMap := make(map[string][]queries.PromResult)
	for r := range ch {
		resultMap[r.name] = r.results
	}

	topicMap := make(map[string]*queries.KafkaTopic)
	getTopic := func(name string) *queries.KafkaTopic {
		if t, ok := topicMap[name]; ok {
			return t
		}
		t := &queries.KafkaTopic{Topic: name}
		topicMap[name] = t
		return t
	}

	for _, r := range resultMap["lag"] {
		topic := r.Metric[rt.TopicLabel]
		if topic == "" {
			continue
		}
		getTopic(topic).MaxLag = safeFloat(r.Value.Float())
	}
	for _, r := range resultMap["partitions"] {
		topic := r.Metric[rt.TopicLabel]
		if topic == "" {
			continue
		}
		getTopic(topic).Partitions = int(safeFloat(r.Value.Float()))
	}
	for _, r := range resultMap["consumed"] {
		topic := r.Metric[rt.TopicLabel]
		if topic == "" {
			continue
		}
		getTopic(topic).ConsumeRate = roundTo(safeFloat(r.Value.Float()), 2)
	}
	for _, r := range resultMap["produced"] {
		topic := r.Metric[rt.TopicLabel]
		if topic == "" {
			continue
		}
		getTopic(topic).ProduceRate = roundTo(safeFloat(r.Value.Float()), 2)
	}

	topics := make([]queries.KafkaTopic, 0, len(topicMap))
	for _, t := range topicMap {
		topics = append(topics, *t)
	}
	// Sort by lag descending (most urgent first)
	sort.Slice(topics, func(i, j int) bool { return topics[i].MaxLag > topics[j].MaxLag })

	if len(topics) == 0 {
		return nil
	}

	return &queries.KafkaRuntime{
		Status: queries.StatusDetected,
		Topics: topics,
	}
}

// ---------------------------------------------------------------------------
// Go runtime metrics
// ---------------------------------------------------------------------------

func (a *App) queryGoRuntime(
	ctx context.Context, client *queries.PrometheusClient,
	svcFilter string, at time.Time, logger log.Logger,
) *queries.GoRuntime {
	rt := a.otelCfg.Runtime.Go
	lookback := "[5m]"

	type qr struct {
		name    string
		results []queries.PromResult
	}

	querySpecs := []struct {
		name  string
		query string
	}{
		{"goroutines", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.Goroutines, svcFilter, lookback)},
		{"threads", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.Threads, svcFilter, lookback)},
		{"memAlloc", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.MemAlloc, svcFilter, lookback)},
		{"memSys", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.MemSys, svcFilter, lookback)},
		{"gcCount", fmt.Sprintf(`sum(rate(%s_count{%s}%s))`, rt.GCDuration, svcFilter, lookback)},
		{"gcSum", fmt.Sprintf(`sum(rate(%s_sum{%s}%s))`, rt.GCDuration, svcFilter, lookback)},
		{"cpuRate", fmt.Sprintf(`avg(rate(%s{%s}%s))`, rt.CPUTotal, svcFilter, lookback)},
		{"openFds", fmt.Sprintf(`avg(avg_over_time(%s{%s}%s))`, rt.OpenFDs, svcFilter, lookback)},
		{"maxFds", fmt.Sprintf(`max(%s{%s})`, rt.MaxFDs, svcFilter)},
		{"podCount", fmt.Sprintf(`count(%s{%s})`, rt.Goroutines, svcFilter)},
		{"info", fmt.Sprintf(`count by (version) (%s{%s})`, rt.Info, svcFilter)},
	}

	var wg sync.WaitGroup
	ch := make(chan qr, len(querySpecs))
	for _, q := range querySpecs {
		wg.Add(1)
		go func(name, query string) {
			defer wg.Done()
			results, err := client.InstantQuery(ctx, query, at)
			if err != nil {
				logger.Debug("Go query failed", "name", name, "error", err)
				return
			}
			ch <- qr{name, results}
		}(q.name, q.query)
	}
	go func() { wg.Wait(); close(ch) }()

	goRt := &queries.GoRuntime{Status: queries.StatusDetected}
	resultMap := make(map[string][]queries.PromResult)
	for r := range ch {
		resultMap[r.name] = r.results
	}

	assignFirst := func(key string, target *float64, decimals int) {
		if rs := resultMap[key]; len(rs) > 0 {
			*target = roundTo(safeFloat(rs[0].Value.Float()), decimals)
		}
	}

	assignFirst("goroutines", &goRt.Goroutines, 0)
	assignFirst("threads", &goRt.Threads, 0)
	assignFirst("memAlloc", &goRt.MemAlloc, 0)
	assignFirst("memSys", &goRt.MemSys, 0)
	assignFirst("cpuRate", &goRt.CPUUsage, 4)
	assignFirst("openFds", &goRt.OpenFDs, 0)
	assignFirst("maxFds", &goRt.MaxFDs, 0)

	// GC
	if countRs, sumRs := resultMap["gcCount"], resultMap["gcSum"]; len(countRs) > 0 {
		goRt.GCRate = roundTo(safeFloat(countRs[0].Value.Float()), 3)
		if len(sumRs) > 0 {
			count := safeFloat(countRs[0].Value.Float())
			sum := safeFloat(sumRs[0].Value.Float())
			if count > 0 {
				goRt.GCPauseAvg = roundTo(sum/count, 6)
			}
		}
	}

	if rs := resultMap["podCount"]; len(rs) > 0 {
		goRt.PodCount = int(safeFloat(rs[0].Value.Float()))
	}

	for _, r := range resultMap["info"] {
		count := int(safeFloat(r.Value.Float()))
		if count > 0 {
			goRt.Versions = append(goRt.Versions, queries.RuntimeVersion{
				Version: r.Metric["version"],
				Count:   count,
			})
		}
	}
	sort.Slice(goRt.Versions, func(i, j int) bool {
		return goRt.Versions[i].Count > goRt.Versions[j].Count
	})

	return goRt
}

// ---------------------------------------------------------------------------
// Container resource metrics (from kubelet / kube-state-metrics)
// ---------------------------------------------------------------------------

func (a *App) queryContainerRuntime(
	ctx context.Context, client *queries.PrometheusClient,
	ctrFilter, service, namespace string, at time.Time, logger log.Logger,
) *queries.ContainerRuntime {
	rt := a.otelCfg.Runtime.Container
	lookback := "[5m]"

	type qr struct {
		name    string
		results []queries.PromResult
	}

	querySpecs := []struct {
		name  string
		query string
	}{
		// CPU usage (rate of counter → cores used)
		{"cpuUsage", fmt.Sprintf(`avg(rate(%s{%s}%s))`, rt.CPUUsage, ctrFilter, lookback)},
		// CPU requests and limits
		{"cpuReqs", fmt.Sprintf(`avg(%s{%s, %s="cpu"})`, rt.ResourceReqs, ctrFilter, rt.ResourceLabel)},
		{"cpuLimits", fmt.Sprintf(`avg(%s{%s, %s="cpu"})`, rt.ResourceLimits, ctrFilter, rt.ResourceLabel)},
		// CPU throttling
		{"cpuThrottled", fmt.Sprintf(`avg(rate(%s{%s}%s))`, rt.CPUThrottled, ctrFilter, lookback)},
		// Memory usage
		{"memUsage", fmt.Sprintf(`avg(%s{%s})`, rt.MemoryUsage, ctrFilter)},
		// Memory requests and limits
		{"memReqs", fmt.Sprintf(`avg(%s{%s, %s="memory"})`, rt.ResourceReqs, ctrFilter, rt.ResourceLabel)},
		{"memLimits", fmt.Sprintf(`avg(%s{%s, %s="memory"})`, rt.ResourceLimits, ctrFilter, rt.ResourceLabel)},
		// Pod count (from container metrics)
		{"podCount", fmt.Sprintf(`count(%s{%s})`, rt.MemoryUsage, ctrFilter)},
		// Restarts (sum across all pods, 24h window to be meaningful)
		{"restarts", fmt.Sprintf(`sum(increase(%s{%s}[24h]))`, rt.Restarts, ctrFilter)},
	}

	// Desired replicas uses deployment label matching, not container filter
	if namespace != "" {
		querySpecs = append(querySpecs, struct {
			name  string
			query string
		}{
			"replicas", fmt.Sprintf(`%s{namespace="%s", deployment="%s"}`, rt.DesiredReplicas, namespace, service),
		})
	}

	var wg sync.WaitGroup
	ch := make(chan qr, len(querySpecs))
	for _, q := range querySpecs {
		wg.Add(1)
		go func(name, query string) {
			defer wg.Done()
			results, err := client.InstantQuery(ctx, query, at)
			if err != nil {
				logger.Debug("Container query failed", "name", name, "error", err)
				return
			}
			ch <- qr{name, results}
		}(q.name, q.query)
	}
	go func() { wg.Wait(); close(ch) }()

	resultMap := make(map[string][]queries.PromResult)
	for r := range ch {
		resultMap[r.name] = r.results
	}

	// Check if we got any data at all
	hasData := false
	for _, rs := range resultMap {
		if len(rs) > 0 {
			hasData = true
			break
		}
	}
	if !hasData {
		return nil
	}

	ctr := &queries.ContainerRuntime{Status: queries.StatusDetected}

	assignFirst := func(key string, target *float64) {
		if rs := resultMap[key]; len(rs) > 0 {
			*target = safeFloat(rs[0].Value.Float())
		}
	}

	assignFirst("cpuUsage", &ctr.CPUUsage)
	assignFirst("cpuReqs", &ctr.CPURequests)
	assignFirst("cpuLimits", &ctr.CPULimits)
	assignFirst("cpuThrottled", &ctr.CPUThrottled)
	assignFirst("memUsage", &ctr.MemoryUsage)
	assignFirst("memReqs", &ctr.MemoryRequests)
	assignFirst("memLimits", &ctr.MemoryLimits)
	assignFirst("restarts", &ctr.Restarts)

	// Round values
	ctr.CPUUsage = roundTo(ctr.CPUUsage, 4)
	ctr.CPUThrottled = roundTo(ctr.CPUThrottled, 4)
	ctr.Restarts = roundTo(ctr.Restarts, 0)

	if rs := resultMap["podCount"]; len(rs) > 0 {
		ctr.PodCount = int(safeFloat(rs[0].Value.Float()))
	}
	if rs := resultMap["replicas"]; len(rs) > 0 {
		ctr.DesiredReplicas = int(safeFloat(rs[0].Value.Float()))
	}

	return ctr
}

// safeFloat returns 0 for NaN/Inf values.
func safeFloat(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}
