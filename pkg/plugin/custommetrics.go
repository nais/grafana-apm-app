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

// Chart hints derived from the metric type. The frontend maps each to a
// type-aware auto-chart (#68 Phase 1):
//   - rate    → sum(rate(X[$__rate_interval]))                       (counter)
//   - p95     → histogram_quantile(0.95, …_bucket…)                  (histogram)
//   - summary → throughput rate(_count) + avg rate(_sum)/rate(_count) (summary/timer)
//   - gauge   → avg(X) aggregated across pods                         (gauge)
const (
	chartRate    = "rate"
	chartP95     = "p95"
	chartSummary = "summary"
	chartGauge   = "gauge"
)

// familyKind classifies a collapsed metric family by its component shape.
// It drives type inference when Mimir has no metadata (the common case on the
// real fleet, where the metadata API returns {} for app metrics).
type familyKind int

const (
	// familyScalar is a single-series family (counter or gauge).
	familyScalar familyKind = iota
	// familyHistogram has a _bucket series (classic or native/OTel histogram).
	familyHistogram
	// familySummary is a Micrometer summary/timer: _count+_sum siblings (and
	// optionally a quantile base series and _max), but no _bucket.
	familySummary
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

	families := collapseFamilies(names)
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
// to count (differs for histograms/summaries, whose component series dominate).
type metricFamily struct {
	name       string     // logical family name (histogram/summary base name)
	seriesName string     // series to count for the cardinality guard
	kind       familyKind // scalar, histogram, or summary
}

// componentSuffixes are the classic-histogram/summary sidecar series that fold
// into their base family. _max is included so Micrometer timers (which emit
// X_max alongside X_count/X_sum) don't leave a stray gauge row (#68 Phase 1).
var componentSuffixes = []string{"_bucket", "_sum", "_count", "_max"}

// collapseFamilies folds multi-series metric families into a single logical
// family so the UI charts them by type rather than per component series:
//
//   - Histograms (a _bucket series exists) collapse X_bucket/X_sum/X_count/X_max
//     into X, typed histogram → histogram_quantile.
//   - Micrometer summaries/timers (X_count+X_sum siblings, no _bucket) collapse
//     X_count/X_sum/X_max — and the bare quantile series X{quantile=…} when
//     present — into X, typed summary → throughput+avg (never quantile: there
//     are no buckets to quantile over). This is the real-fleet shape that
//     Phase 0 split into 3–4 mistyped gauge rows.
//   - Everything else stays a single-series scalar family (counter or gauge),
//     resolved later by naming heuristics.
func collapseFamilies(names map[string]bool) []metricFamily {
	// Base names with a _bucket series are histograms.
	histograms := make(map[string]bool)
	for name := range names {
		if base, ok := strings.CutSuffix(name, "_bucket"); ok && base != "" {
			histograms[base] = true
		}
	}
	// Base names with both _count and _sum siblings but no _bucket are
	// summaries/timers (Micrometer's percentile-less shape).
	summaries := make(map[string]bool)
	for name := range names {
		if base, ok := strings.CutSuffix(name, "_count"); ok && base != "" && !histograms[base] {
			if names[base+"_sum"] {
				summaries[base] = true
			}
		}
	}

	families := make([]metricFamily, 0, len(names))
	seen := make(map[string]bool, len(names))
	add := func(name, seriesName string, kind familyKind) {
		if !seen[name] {
			seen[name] = true
			families = append(families, metricFamily{name: name, seriesName: seriesName, kind: kind})
		}
	}

	for name := range names {
		// Fold a component series (X_count, X_sum, X_max, X_bucket) into its base.
		base := name
		for _, suffix := range componentSuffixes {
			if b, ok := strings.CutSuffix(name, suffix); ok && (histograms[b] || summaries[b]) {
				base = b
				break
			}
		}
		// The bare base series (Micrometer's X{quantile=…}) folds too.
		if histograms[name] || summaries[name] {
			base = name
		}

		switch {
		case histograms[base]:
			add(base, base+"_bucket", familyHistogram)
		case summaries[base]:
			// _count is one series per label set — the right cardinality proxy.
			add(base, base+"_count", familySummary)
		default:
			add(name, name, familyScalar)
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

// guessMetricType infers a metric type when Mimir has no metadata — the common
// case, since the metadata API returns {} for essentially all app metrics, so
// this heuristic path (not the metadata branch) is what actually types the
// real fleet.
//
//   - Histogram/summary families are typed from their collapsed component shape.
//   - Scalars are typed by name: monotonic-counter conventions → counter,
//     else gauge. This fixes _total-less Micrometer counters (e.g.
//     frontend_call_counter), which Phase 0 mistyped as gauges and charted raw
//     instead of as a rate.
func guessMetricType(fam metricFamily) string {
	switch fam.kind {
	case familyHistogram:
		return "histogram"
	case familySummary:
		return "summary"
	}
	if isCounterName(fam.name) {
		return "counter"
	}
	return "gauge"
}

// counterSuffixes are monotonic-counter naming conventions. _total is the
// canonical OpenMetrics suffix; _count/_counter cover the _total-less
// Micrometer/OTel counters that land in Mimir without it (a standalone X_count
// here is not a summary component — those were already collapsed away).
var counterSuffixes = []string{"_total", "_count", "_counter"}

// isCounterName reports whether a scalar metric name follows a counter
// convention, so it charts as a rate rather than a raw value.
func isCounterName(name string) bool {
	for _, suffix := range counterSuffixes {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
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
	case "summary":
		return chartSummary
	default:
		return chartGauge
	}
}
