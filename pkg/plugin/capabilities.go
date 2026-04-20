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

// Candidate metric names and their namespace derivation.
// We probe these in order, first match wins.
var spanMetricsCandidates = []struct {
	calls      string
	durMs      string
	durSec     string
	latencySec string // Tempo metrics generator uses "latency" instead of "duration"
	ns         string
}{
	{
		calls:      "traces_span_metrics_calls_total",
		durMs:      "traces_span_metrics_duration_milliseconds_bucket",
		durSec:     "traces_span_metrics_duration_seconds_bucket",
		latencySec: "traces_span_metrics_latency_bucket",
		ns:         "traces_span_metrics",
	},
	{
		calls:      "traces_spanmetrics_calls_total",
		durMs:      "traces_spanmetrics_duration_milliseconds_bucket",
		durSec:     "traces_spanmetrics_duration_seconds_bucket",
		latencySec: "traces_spanmetrics_latency_bucket",
		ns:         "traces_spanmetrics",
	},
	{
		calls:      "spanmetrics_calls_total",
		durMs:      "spanmetrics_duration_milliseconds_bucket",
		durSec:     "spanmetrics_duration_seconds_bucket",
		latencySec: "spanmetrics_latency_bucket",
		ns:         "spanmetrics",
	},
	{
		calls:      "calls_total",
		durMs:      "duration_milliseconds_bucket",
		durSec:     "duration_seconds_bucket",
		latencySec: "latency_bucket",
		ns:         "",
	},
}

// Candidate service graph metric prefixes. We probe these in order, first match wins.
var serviceGraphCandidates = []struct {
	probe  string // metric to check existence
	prefix string // prefix for all service_graph metrics
}{
	{probe: "traces_service_graph_request_total", prefix: "traces_service_graph"},
	{probe: "service_graph_request_total", prefix: "service_graph"},
}

type cachedCapabilities struct {
	caps      queries.Capabilities
	fetchedAt time.Time
}

const capabilitiesCacheTTL = 5 * time.Minute

func (a *App) handleCapabilities(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Check cache — only serve cached results if detection succeeded or
	// if we're still within the short negative-cache TTL (30s) to avoid
	// hammering a broken Mimir.
	a.capMu.RLock()
	cached := a.capCache
	a.capMu.RUnlock()

	if cached != nil {
		ttl := capabilitiesCacheTTL
		if !cached.caps.SpanMetrics.Detected {
			// Negative results expire faster so we retry detection sooner
			ttl = 30 * time.Second
		}
		if time.Since(cached.fetchedAt) < ttl {
			writeJSON(w, cached.caps)
			return
		}
	}

	ctx := req.Context()
	ctx = withAuthContext(ctx, a.promClientForRequest(req))

	caps := a.detectCapabilities(ctx)

	a.capMu.Lock()
	a.capCache = &cachedCapabilities{caps: caps, fetchedAt: time.Now()}
	a.capMu.Unlock()

	writeJSON(w, caps)
}

func (a *App) detectCapabilities(ctx context.Context) queries.Capabilities {
	logger := log.DefaultLogger.With("handler", "capabilities")
	caps := queries.Capabilities{}

	if a.promClient == nil {
		logger.Warn("No prometheus client configured")
		return caps
	}

	// Detect span metrics namespace by probing known candidates
	for _, c := range spanMetricsCandidates {
		exists, err := a.prom(ctx).SeriesExists(ctx, c.calls)
		if err != nil {
			logger.Debug("Probe failed", "metric", c.calls, "error", err)
			continue
		}
		if exists {
			caps.SpanMetrics.Detected = true
			caps.SpanMetrics.Namespace = c.ns
			caps.SpanMetrics.CallsMetric = c.calls

			// Detect duration unit: try milliseconds first, then seconds, then latency (Tempo)
			msExists, _ := a.prom(ctx).SeriesExists(ctx, c.durMs)
			if msExists {
				caps.SpanMetrics.DurationMetric = c.durMs
				caps.SpanMetrics.DurationUnit = "ms"
			} else {
				secExists, _ := a.prom(ctx).SeriesExists(ctx, c.durSec)
				if secExists {
					caps.SpanMetrics.DurationMetric = c.durSec
					caps.SpanMetrics.DurationUnit = "s"
				} else if c.latencySec != "" {
					latExists, _ := a.prom(ctx).SeriesExists(ctx, c.latencySec)
					if latExists {
						caps.SpanMetrics.DurationMetric = c.latencySec
						caps.SpanMetrics.DurationUnit = "s"
					}
				}
			}
			logger.Info("Detected span metrics", "namespace", c.ns, "durationUnit", caps.SpanMetrics.DurationUnit)
			break
		}
	}

	// Detect service graph
	for _, sg := range serviceGraphCandidates {
		sgExists, err := a.prom(ctx).SeriesExists(ctx, sg.probe)
		if err != nil {
			logger.Debug("Service graph probe failed", "metric", sg.probe, "error", err)
			continue
		}
		if sgExists {
			caps.ServiceGraph.Detected = true
			caps.ServiceGraph.Prefix = sg.prefix
			logger.Info("Detected service graph", "prefix", sg.prefix)
			break
		}
	}

	// Detect available services
	if caps.SpanMetrics.Detected {
		caps.Services = a.detectServices(ctx, caps.SpanMetrics.CallsMetric)
	}

	// Check Tempo reachability (default)
	caps.Tempo = a.checkHTTPHealth(ctx, a.tempoURL(""), "/api/status/buildinfo")

	// Check Loki reachability (default)
	caps.Loki = a.checkHTTPHealth(ctx, a.lokiURL(""), "/loki/api/v1/labels")

	// Check per-environment datasource reachability
	if len(a.settings.TracesDataSource.ByEnvironment) > 0 {
		caps.TempoByEnv = make(map[string]queries.DataSourceStatus)
		for env := range a.settings.TracesDataSource.ByEnvironment {
			caps.TempoByEnv[env] = a.checkHTTPHealth(ctx, a.tempoURL(env), "/api/status/buildinfo")
		}
	}
	if len(a.settings.LogsDataSource.ByEnvironment) > 0 {
		caps.LokiByEnv = make(map[string]queries.DataSourceStatus)
		for env := range a.settings.LogsDataSource.ByEnvironment {
			caps.LokiByEnv[env] = a.checkHTTPHealth(ctx, a.lokiURL(env), "/loki/api/v1/labels")
		}
	}

	return caps
}

func (a *App) detectServices(ctx context.Context, callsMetric string) []string {
	query := fmt.Sprintf(`group by (service_name) (%s)`, callsMetric)
	results, err := a.prom(ctx).InstantQuery(ctx, query, time.Now())
	if err != nil {
		log.DefaultLogger.Warn("Failed to detect services", "error", err)
		return nil
	}

	var services []string
	for _, r := range results {
		if name, ok := r.Metric["service_name"]; ok && name != "" {
			services = append(services, name)
		}
	}
	return services
}

func (a *App) checkHTTPHealth(ctx context.Context, baseURL, path string) queries.DataSourceStatus {
	if baseURL == "" {
		return queries.DataSourceStatus{Available: false, Error: "not configured"}
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+path, nil)
	if err != nil {
		return queries.DataSourceStatus{Available: false, Error: err.Error()}
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return queries.DataSourceStatus{Available: false, Error: err.Error()}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return queries.DataSourceStatus{Available: true}
	}
	return queries.DataSourceStatus{Available: false, Error: fmt.Sprintf("HTTP %d", resp.StatusCode)}
}

// capMu and capCache are initialized in App struct

func writeJSON(w http.ResponseWriter, v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
	w.Write([]byte("\n"))
}

// requireGET returns true if the request is GET, otherwise writes 405 and returns false.
func requireGET(w http.ResponseWriter, req *http.Request) bool {
	if req.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

// requireServiceParam validates service path param and writes 400 if empty.
func requireServiceParam(w http.ResponseWriter, service string) bool {
	if service == "" {
		http.Error(w, `{"error":"missing or invalid service"}`, http.StatusBadRequest)
		return false
	}
	return true
}
