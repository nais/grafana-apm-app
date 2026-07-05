package plugin

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// maxCustomMetricFamilies caps the discovery response; beyond it the payload
// is truncated (alphabetically) and Truncated is set (#68 Phase 0).
const maxCustomMetricFamilies = 50

// highCardinalityThreshold is the active-series count above which a family is
// listed but flagged so the UI does not auto-chart it ("open in Explore").
const highCardinalityThreshold = 100

// customMetricEnrichConcurrency bounds the per-family metadata + series-count
// fan-out (2 queries per family, up to 50 families → peak 16 in flight).
const customMetricEnrichConcurrency = 8

// Chart hints derived from the metric type: counter→rate, histogram→p95,
// everything else→gauge.
const (
	chartRate  = "rate"
	chartP95   = "p95"
	chartGauge = "gauge"
)

// CustomMetric is one discovered non-platform metric family.
type CustomMetric struct {
	Name string `json:"name"`
	// Type is the Prometheus metadata type (counter, gauge, histogram,
	// summary, …), or a suffix-heuristic guess when metadata is absent.
	Type string `json:"type"`
	Help string `json:"help"`
	Unit string `json:"unit"`
	// Series is the active series count for the family within the service
	// filter (for histograms: the _bucket series, which drive the cost).
	Series          int    `json:"series"`
	HighCardinality bool   `json:"highCardinality"`
	Chart           string `json:"chart"`
}

// CustomMetricsResponse is the /custom-metrics payload.
type CustomMetricsResponse struct {
	Metrics   []CustomMetric `json:"metrics"`
	Truncated bool           `json:"truncated"`
}

// handleCustomMetrics discovers a service's custom (non-platform) metric
// families in Mimir, enriched with type/help/unit metadata and series counts.
// GET /services/{namespace}/{service}/custom-metrics?from=&to=&environment=
func (a *App) handleCustomMetrics(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)

	namespace, service := parseServiceRef(req)
	environment := parseEnvironment(req)
	if !requireServiceParam(w, service) {
		return
	}

	from, to := parseTimeRange(req)

	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("custommetrics", orgID, roundedUnix(from), roundedUnix(to), namespace, service, environment)
	// The PRD asks for a 5-minute catalog cache (capabilities.go pattern);
	// respCache is a single-TTL cache currently set to 30s, so entries expire
	// sooner than ideal. Acceptable for Phase 0 — revisit if discovery-query
	// load shows up on Mimir.
	a.writeCached(w, ck, "querying custom metrics failed", func() (any, error) {
		return a.queryCustomMetrics(ctx, namespace, service, environment, to), nil
	})
}

// queryCustomMetrics runs the denylist-inverted discovery query (the mirror
// image of runtime.go's allowlist discovery), collapses classic-histogram
// series (_bucket/_sum/_count) into their base family, then fans out bounded
// metadata + series-count queries per family.
func (a *App) queryCustomMetrics(ctx context.Context, namespace, service, environment string, at time.Time) CustomMetricsResponse {
	logger := log.DefaultLogger.With("handler", "custom-metrics")
	resp := CustomMetricsResponse{Metrics: []CustomMetric{}}

	client := a.prom(ctx)
	if client == nil {
		return resp
	}

	svcFilter := a.otelCfg.RuntimeFilter(service, namespace)
	if environment != "" {
		svcFilter += fmt.Sprintf(`, %s="%s"`, a.otelCfg.Labels.DeploymentEnv, environment)
	}

	discoveryQuery := fmt.Sprintf(
		`group by (__name__) ({%s, __name__!~"%s"})`,
		svcFilter, a.otelCfg.CustomMetrics.Denylist,
	)
	results, err := client.InstantQuery(ctx, discoveryQuery, at)
	if err != nil {
		logger.Warn("custom metrics discovery query failed", "error", err)
		return resp
	}

	names := make(map[string]bool, len(results))
	for _, r := range results {
		if name := r.Metric["__name__"]; name != "" {
			names[name] = true
		}
	}
	if len(names) == 0 {
		return resp
	}

	families := collapseHistogramFamilies(names)
	sort.Slice(families, func(i, j int) bool { return families[i].name < families[j].name })
	if len(families) > maxCustomMetricFamilies {
		families = families[:maxCustomMetricFamilies]
		resp.Truncated = true
	}

	metrics := make([]CustomMetric, len(families))
	var wg sync.WaitGroup
	sem := make(chan struct{}, customMetricEnrichConcurrency)
	for i, fam := range families {
		wg.Add(1)
		go func(i int, fam metricFamily) {
			sem <- struct{}{}
			defer func() { <-sem }()
			defer wg.Done()
			metrics[i] = a.enrichCustomMetric(ctx, client, fam, svcFilter, at, logger)
		}(i, fam)
	}
	wg.Wait()

	resp.Metrics = metrics
	return resp
}

// metricFamily is a discovered family: the logical name plus the series name
// to count (differs for classic histograms, where _bucket series dominate).
type metricFamily struct {
	name        string // logical family name (histogram base name)
	seriesName  string // series to count for the cardinality guard
	isHistogram bool
}

// collapseHistogramFamilies folds classic-histogram component series
// (X_bucket, X_sum, X_count) into a single family X when X_bucket exists.
// A lone X_count/X_sum without X_bucket is kept as-is — it may be a real
// counter/gauge, and guessing summary semantics here would misle the UI.
func collapseHistogramFamilies(names map[string]bool) []metricFamily {
	// Base names with a _bucket series are histograms.
	histograms := make(map[string]bool)
	for name := range names {
		if base, ok := strings.CutSuffix(name, "_bucket"); ok && base != "" {
			histograms[base] = true
		}
	}

	families := make([]metricFamily, 0, len(names))
	seen := make(map[string]bool, len(names))
	for name := range names {
		base := name
		for _, suffix := range []string{"_bucket", "_sum", "_count"} {
			if b, ok := strings.CutSuffix(name, suffix); ok && histograms[b] {
				base = b
				break
			}
		}
		if histograms[base] {
			if !seen[base] {
				seen[base] = true
				families = append(families, metricFamily{name: base, seriesName: base + "_bucket", isHistogram: true})
			}
			continue
		}
		if !seen[name] {
			seen[name] = true
			families = append(families, metricFamily{name: name, seriesName: name})
		}
	}
	return families
}

// enrichCustomMetric fetches metadata (type/help/unit) and the active series
// count for one family, falling back to suffix heuristics when Mimir has no
// metadata for it (metadata ingestion may be disabled or inconsistent).
func (a *App) enrichCustomMetric(
	ctx context.Context, client *queries.PrometheusClient,
	fam metricFamily, svcFilter string, at time.Time, logger log.Logger,
) CustomMetric {
	m := CustomMetric{Name: fam.name}

	var (
		wg       sync.WaitGroup
		metaList []queries.MetricMetadata
		countRes []queries.PromResult
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		var err error
		metaList, err = client.Metadata(ctx, fam.name)
		if err != nil {
			logger.Debug("metadata query failed", "metric", fam.name, "error", err)
		}
	}()
	go func() {
		defer wg.Done()
		countQuery := fmt.Sprintf(`count({__name__="%s", %s})`, fam.seriesName, svcFilter)
		var err error
		countRes, err = client.InstantQuery(ctx, countQuery, at)
		if err != nil {
			logger.Debug("series count query failed", "metric", fam.name, "error", err)
		}
	}()
	wg.Wait()

	if len(metaList) > 0 {
		m.Type = metaList[0].Type
		m.Help = metaList[0].Help
		m.Unit = metaList[0].Unit
	}
	if m.Type == "" || m.Type == "unknown" {
		m.Type = guessMetricType(fam)
	}
	if m.Unit == "" {
		m.Unit = guessMetricUnit(fam.name)
	}

	if len(countRes) > 0 {
		m.Series = int(safeFloat(countRes[0].Value.Float()))
	}
	m.HighCardinality = m.Series > highCardinalityThreshold
	m.Chart = chartForType(m.Type)
	return m
}

// guessMetricType applies OpenMetrics naming-convention heuristics when
// metadata is absent: _bucket family→histogram, _total→counter, else gauge.
func guessMetricType(fam metricFamily) string {
	if fam.isHistogram {
		return "histogram"
	}
	if strings.HasSuffix(fam.name, "_total") {
		return "counter"
	}
	return "gauge"
}

// guessMetricUnit derives a unit from conventional name suffixes/segments.
func guessMetricUnit(name string) string {
	trimmed := strings.TrimSuffix(name, "_total")
	for _, unit := range []string{"milliseconds", "seconds", "bytes"} {
		if strings.HasSuffix(trimmed, "_"+unit) || strings.Contains(trimmed, "_"+unit+"_") {
			return unit
		}
	}
	return ""
}

// chartForType maps a metric type to the auto-chart hint the UI renders.
func chartForType(metricType string) string {
	switch metricType {
	case "counter":
		return chartRate
	case "histogram":
		return chartP95
	default:
		return chartGauge
	}
}
