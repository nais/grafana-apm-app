package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// traceDimension is one groupable attribute for the trace breakdown. The three
// names differ per surface: `key` is the API/UI contract, `traceAttr` is the
// TraceQL selector (intrinsic `name`, or `span.*` for span attributes), and
// `promLabel` is the span-metrics label used by the PromQL fallback.
type traceDimension struct {
	key       string
	traceAttr string
	promLabel func(l otelconfig.Labels) string
}

// traceDimensions are the curated group-by candidates. HTTP semconv attrs are
// included even though they are frequently nil fleet-wide — availability is
// probed per service and unavailable ones are dropped from the response.
var traceDimensions = []traceDimension{
	{"name", "name", func(l otelconfig.Labels) string { return l.SpanName }},
	{"http.route", "span.http.route", func(l otelconfig.Labels) string { return l.HTTPRoute }},
	{"http.status_code", "span.http.status_code", func(l otelconfig.Labels) string { return l.HTTPStatusCode }},
	{"db.system", "span.db.system", func(l otelconfig.Labels) string { return l.DBSystem }},
	{"db.operation", "span.db.operation", func(l otelconfig.Labels) string { return l.DBOperation }},
	{"messaging.system", "span.messaging.system", func(l otelconfig.Labels) string { return l.MessagingSystem }},
	{"rpc.method", "span.rpc.method", func(l otelconfig.Labels) string { return l.RPCMethod }},
}

func dimensionByKey(key string) (traceDimension, bool) {
	for _, d := range traceDimensions {
		if d.key == key {
			return d, true
		}
	}
	return traceDimension{}, false
}

// TraceBreakdownRow is one grouped value with its RED metrics.
type TraceBreakdownRow struct {
	Value     string  `json:"value"`
	Rate      float64 `json:"rate"`
	ErrorRate float64 `json:"errorRate"`
	P95Ms     float64 `json:"p95Ms"`
	P99Ms     float64 `json:"p99Ms"`
}

// TraceBreakdownResponse is the /traces/breakdown payload. Dimensions lists the
// group-by attributes that actually carry data for this service, so the UI can
// offer only usable options.
type TraceBreakdownResponse struct {
	// Mode is one of: traceql, spanmetrics, unavailable.
	Mode       string              `json:"mode"`
	Dimension  string              `json:"dimension"`
	Dimensions []string            `json:"dimensions"`
	Rows       []TraceBreakdownRow `json:"rows"`
	Note       string              `json:"note,omitempty"`
}

// handleTraceBreakdown returns a per-dimension RED breakdown for a service's
// spans. GET /services/{namespace}/{service}/traces/breakdown?from=&to=&tracesUid=&dimension=
func (a *App) handleTraceBreakdown(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	namespace, service := parseServiceRef(req)
	if !requireServiceParam(w, service) {
		return
	}
	from, to := parseTimeRange(req)
	tracesUID := sanitizeDatasourceUID(req.URL.Query().Get("tracesUid"))
	if tracesUID == "" {
		writeJSON(w, TraceBreakdownResponse{Mode: "unavailable", Rows: []TraceBreakdownRow{}, Note: "traces datasource not configured"})
		return
	}
	// Restrict the dimension to the curated set; default to span name.
	dimension := req.URL.Query().Get("dimension")
	if _, ok := dimensionByKey(dimension); !ok {
		dimension = "name"
	}

	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("tracebreakdown", orgID, roundedUnix(from), roundedUnix(to), namespace, service, tracesUID, dimension)
	headers := req.Header
	a.writeCached(w, ck, "querying trace breakdown failed", func() (any, error) {
		return a.queryTraceBreakdown(ctx, headers, tracesUID, namespace, service, dimension, from, to), nil
	})
}

func (a *App) queryTraceBreakdown(ctx context.Context, headers http.Header, tracesUID, namespace, service, dimension string, from, to time.Time) TraceBreakdownResponse {
	logger := log.DefaultLogger.With("handler", "trace-breakdown")
	tc := newTempoQueryClient(a.grafanaURL, a.resolveServiceToken(ctx), headers)

	// Probe (cached) which curated dimensions carry data on this datasource for
	// this service. When Tempo answers at all, we serve TraceQL metrics.
	dims, tempoOK := a.traceDimensionCaps(ctx, tc, tracesUID, service, from, to)
	if tempoOK {
		rows := a.traceQLBreakdown(ctx, tc, tracesUID, service, dimension, from, to)
		return TraceBreakdownResponse{Mode: "traceql", Dimension: dimension, Dimensions: dims, Rows: rows}
	}

	// Fallback: span-metrics in Mimir, grouped by the Prometheus label.
	logger.Warn("Tempo TraceQL metrics unavailable, falling back to span metrics")
	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.SpanMetrics.Detected {
		return TraceBreakdownResponse{Mode: "unavailable", Dimension: dimension, Rows: []TraceBreakdownRow{}, Note: "trace metrics unavailable"}
	}
	fbDims, rows := a.spanMetricsBreakdown(ctx, caps, namespace, service, dimension, to)
	return TraceBreakdownResponse{Mode: "spanmetrics", Dimension: dimension, Dimensions: fbDims, Rows: rows, Note: "computed from span metrics (Tempo TraceQL metrics unavailable)"}
}

// ---------------------------------------------------------------------------
// Per-UID+service dimension capability cache
// ---------------------------------------------------------------------------

type traceDimsCacheEntry struct {
	dims      []string
	tempoOK   bool
	fetchedAt time.Time
}

const traceDimsTTL = 5 * time.Minute

var (
	traceDimsMu    sync.Mutex
	traceDimsCache = map[string]traceDimsCacheEntry{}
)

// traceDimensionCaps returns the curated dimensions that carry real values for
// this service, plus whether Tempo answered at all. Keyed by uid+service with a
// short TTL — availability is a stable property of the service's span shape,
// not the exact time window.
func (a *App) traceDimensionCaps(ctx context.Context, tc *tempoQueryClient, uid, service string, from, to time.Time) ([]string, bool) {
	key := uid + "\x00" + service
	traceDimsMu.Lock()
	if e, ok := traceDimsCache[key]; ok && time.Since(e.fetchedAt) < traceDimsTTL {
		traceDimsMu.Unlock()
		return e.dims, e.tempoOK
	}
	traceDimsMu.Unlock()

	dims, tempoOK := a.detectTraceDimensions(ctx, tc, uid, service, from, to)

	traceDimsMu.Lock()
	traceDimsCache[key] = traceDimsCacheEntry{dims: dims, tempoOK: tempoOK, fetchedAt: time.Now()}
	traceDimsMu.Unlock()
	return dims, tempoOK
}

// detectTraceDimensions probes each candidate with a cheap `rate() by (attr)`
// and keeps those that return at least one real value. Any successful response
// (even empty) marks Tempo as reachable; only when every probe errors do we
// declare TraceQL metrics unavailable.
func (a *App) detectTraceDimensions(ctx context.Context, tc *tempoQueryClient, uid, service string, from, to time.Time) ([]string, bool) {
	step := breakdownStep(from, to)
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		avail   = map[string]bool{}
		anyOK   bool
		allFail = true
	)
	for _, d := range traceDimensions {
		d := d
		wg.Add(1)
		go func() {
			defer wg.Done()
			query := fmt.Sprintf(`{%s="%s"} | rate() by (%s)`, a.otelCfg.TraceQL.ServiceName, service, d.traceAttr)
			series, err := tc.metricQuery(ctx, uid, query, step, from, to)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				return
			}
			allFail = false
			for _, s := range series {
				if realDimensionValue(s.labels[d.traceAttr]) {
					avail[d.key] = true
					anyOK = true
					break
				}
			}
		}()
	}
	wg.Wait()

	if allFail {
		return nil, false
	}
	// Preserve curated order. `name` is intrinsic and effectively always
	// present when Tempo answered; include it so the UI always has a default.
	dims := make([]string, 0, len(traceDimensions))
	for _, d := range traceDimensions {
		if avail[d.key] || (d.key == "name" && anyOK) {
			dims = append(dims, d.key)
		}
	}
	if len(dims) == 0 {
		dims = []string{"name"}
	}
	return dims, true
}

// realDimensionValue reports whether a grouped attribute value is a usable
// dimension value. Tempo renders absent attributes as the literal "nil" and
// wraps values in quotes (stripped upstream); empty means the label was absent.
func realDimensionValue(v string) bool {
	v = strings.TrimSpace(v)
	return v != "" && v != "nil"
}

// ---------------------------------------------------------------------------
// TraceQL metrics mode
// ---------------------------------------------------------------------------

// traceQLBreakdown computes rate/error-rate/p95/p99 per value of the selected
// dimension via three TraceQL metrics queries.
func (a *App) traceQLBreakdown(ctx context.Context, tc *tempoQueryClient, uid, service, dimension string, from, to time.Time) []TraceBreakdownRow {
	dim, ok := dimensionByKey(dimension)
	if !ok {
		return []TraceBreakdownRow{}
	}
	svc := a.otelCfg.TraceQL.ServiceName
	step := breakdownStep(from, to)

	rateQ := fmt.Sprintf(`{%s="%s"} | rate() by (%s, status)`, svc, service, dim.traceAttr)
	p95Q := fmt.Sprintf(`{%s="%s"} | quantile_over_time(duration, .95) by (%s)`, svc, service, dim.traceAttr)
	p99Q := fmt.Sprintf(`{%s="%s"} | quantile_over_time(duration, .99) by (%s)`, svc, service, dim.traceAttr)

	var (
		wg                  sync.WaitGroup
		rateS, p95S, p99S   []tempoSeries
		rateErr, p95E, p99E error
	)
	wg.Add(3)
	go func() { defer wg.Done(); rateS, rateErr = tc.metricQuery(ctx, uid, rateQ, step, from, to) }()
	go func() { defer wg.Done(); p95S, p95E = tc.metricQuery(ctx, uid, p95Q, step, from, to) }()
	go func() { defer wg.Done(); p99S, p99E = tc.metricQuery(ctx, uid, p99Q, step, from, to) }()
	wg.Wait()
	if rateErr != nil {
		log.DefaultLogger.Warn("TraceQL rate query failed", "error", rateErr, "dimension", dimension)
	}
	if p95E != nil || p99E != nil {
		log.DefaultLogger.Warn("TraceQL quantile query failed", "p95", p95E, "p99", p99E)
	}

	rows := make(map[string]*TraceBreakdownRow)
	get := func(value string) *TraceBreakdownRow {
		r, ok := rows[value]
		if !ok {
			r = &TraceBreakdownRow{Value: value}
			rows[value] = r
		}
		return r
	}

	// Rate + error rate: sum all statuses for the total, the error status for
	// the numerator (errorRate() is not valid TraceQL — we divide client-side).
	errorRate := map[string]float64{}
	for _, s := range rateS {
		value := s.labels[dim.traceAttr]
		if !realDimensionValue(value) {
			continue
		}
		r := get(value)
		r.Rate += s.value
		if strings.EqualFold(s.labels["status"], "error") {
			errorRate[value] += s.value
		}
	}
	for value, r := range rows {
		if r.Rate > 0 {
			r.ErrorRate = roundTo(100*errorRate[value]/r.Rate, 1)
		}
		r.Rate = roundTo(r.Rate, 3)
	}

	// Quantiles arrive in seconds; convert to milliseconds.
	for _, s := range p95S {
		if value := s.labels[dim.traceAttr]; realDimensionValue(value) {
			get(value).P95Ms = roundTo(s.value*1000, 2)
		}
	}
	for _, s := range p99S {
		if value := s.labels[dim.traceAttr]; realDimensionValue(value) {
			get(value).P99Ms = roundTo(s.value*1000, 2)
		}
	}

	out := make([]TraceBreakdownRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].P99Ms != out[j].P99Ms {
			return out[i].P99Ms > out[j].P99Ms
		}
		return out[i].Value < out[j].Value
	})
	return out
}

// breakdownStep picks a single step spanning most of the window so 2–3 buckets
// are returned and averaged (Tempo has no instant mode). Bounded to keep the
// bucket count sane on very wide windows.
func breakdownStep(from, to time.Time) string {
	span := to.Sub(from)
	if span < time.Minute {
		span = time.Minute
	}
	step := span / 2
	if step > 30*time.Minute {
		step = 30 * time.Minute
	}
	if step < 15*time.Second {
		step = 15 * time.Second
	}
	return strconv.FormatInt(int64(step.Seconds()), 10) + "s"
}

// ---------------------------------------------------------------------------
// File-local Tempo /api/ds/query metrics client
// ---------------------------------------------------------------------------

// tempoQueryClient posts TraceQL metrics queries to Grafana's /api/ds/query.
// DsQueryClient can't be reused here: TraceQL metrics need query/step fields
// it doesn't model, and the response is a multi-bucket time series we average
// rather than take the last sample of.
type tempoQueryClient struct {
	grafanaURL   string
	serviceToken string
	headers      http.Header
	httpClient   *http.Client
}

func newTempoQueryClient(grafanaURL, serviceToken string, headers http.Header) *tempoQueryClient {
	return &tempoQueryClient{
		grafanaURL:   grafanaURL,
		serviceToken: serviceToken,
		headers:      headers,
		httpClient:   &http.Client{Timeout: 30 * time.Second},
	}
}

// tempoSeries is one returned series: its group-by labels (quotes stripped) and
// the mean of the non-null buckets.
type tempoSeries struct {
	labels map[string]string
	value  float64
}

type tempoDsRequest struct {
	From    string          `json:"from"`
	To      string          `json:"to"`
	Queries []tempoDsTarget `json:"queries"`
}

type tempoDsTarget struct {
	RefID      string     `json:"refId"`
	Datasource tempoDsRef `json:"datasource"`
	QueryType  string     `json:"queryType"`
	Query      string     `json:"query"`
	Step       string     `json:"step"`
}

type tempoDsRef struct {
	UID  string `json:"uid"`
	Type string `json:"type"`
}

type tempoDsFrame struct {
	Schema struct {
		Fields []struct {
			Name   string            `json:"name"`
			Labels map[string]string `json:"labels,omitempty"`
		} `json:"fields"`
	} `json:"schema"`
	Data struct {
		Values []json.RawMessage `json:"values"`
	} `json:"data"`
}

type tempoDsResponse struct {
	Results map[string]struct {
		Error  string         `json:"error,omitempty"`
		Frames []tempoDsFrame `json:"frames"`
	} `json:"results"`
}

// metricQuery posts one TraceQL metrics query and returns its series with each
// value averaged over the returned buckets.
func (c *tempoQueryClient) metricQuery(ctx context.Context, uid, query, step string, from, to time.Time) ([]tempoSeries, error) {
	body, err := json.Marshal(tempoDsRequest{
		From: strconv.FormatInt(from.UnixMilli(), 10),
		To:   strconv.FormatInt(to.UnixMilli(), 10),
		Queries: []tempoDsTarget{{
			RefID:      "A",
			Datasource: tempoDsRef{UID: uid, Type: "tempo"},
			QueryType:  "traceql",
			Query:      query,
			Step:       step,
		}},
	})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.grafanaURL+"/api/ds/query", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	applyProxyAuth(req, c.headers, c.serviceToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ds query returned %d: %s", resp.StatusCode, truncateStr(string(raw), 256))
	}

	var envelope tempoDsResponse
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	result, ok := envelope.Results["A"]
	if !ok {
		return nil, fmt.Errorf("ds query response missing refId A")
	}
	if result.Error != "" {
		return nil, fmt.Errorf("ds query error: %s", result.Error)
	}

	var out []tempoSeries
	for _, frame := range result.Frames {
		// Value field is the non-time field carrying the group-by labels.
		for i := 1; i < len(frame.Schema.Fields) && i < len(frame.Data.Values); i++ {
			var nums []*float64
			if err := json.Unmarshal(frame.Data.Values[i], &nums); err != nil {
				continue
			}
			mean, ok := meanNonNull(nums)
			if !ok {
				continue
			}
			out = append(out, tempoSeries{labels: stripQuotedLabels(frame.Schema.Fields[i].Labels), value: mean})
		}
	}
	return out, nil
}

// meanNonNull averages the non-null bucket values; ok is false when every
// bucket is null (series carries no data in the window).
func meanNonNull(nums []*float64) (float64, bool) {
	var sum float64
	var n int
	for _, v := range nums {
		if v == nil {
			continue
		}
		sum += *v
		n++
	}
	if n == 0 {
		return 0, false
	}
	return sum / float64(n), true
}

// stripQuotedLabels removes the surrounding double quotes Tempo wraps around
// TraceQL label values (e.g. `"unset"` → `unset`).
func stripQuotedLabels(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = strings.Trim(v, `"`)
	}
	return out
}

// ---------------------------------------------------------------------------
// Span-metrics PromQL fallback (mirrors operations.go)
// ---------------------------------------------------------------------------

// spanMetricsBreakdown computes the breakdown from span metrics in Mimir when
// TraceQL metrics are unavailable, grouping by the dimension's Prometheus label.
// Returns the dimensions that have data plus the requested dimension's rows.
func (a *App) spanMetricsBreakdown(ctx context.Context, caps queries.Capabilities, namespace, service, dimension string, at time.Time) ([]string, []TraceBreakdownRow) {
	logger := log.DefaultLogger.With("handler", "trace-breakdown-fallback")
	dim, ok := dimensionByKey(dimension)
	if !ok {
		return []string{"name"}, []TraceBreakdownRow{}
	}
	callsMetric := caps.SpanMetrics.CallsMetric
	durationBucket := caps.SpanMetrics.DurationMetric
	durationUnit := caps.SpanMetrics.DurationUnit
	rangeStr := "[5m]"

	baseFilter := a.otelCfg.ServiceFilter(service, namespace)
	label := dim.promLabel(a.otelCfg.Labels)
	// Restrict to series where the grouping label is present.
	filter := baseFilter + fmt.Sprintf(`, %s!=""`, label)

	rateQ := otelconfig.Rate(callsMetric, filter, label, rangeStr)
	errorQ := otelconfig.Rate(callsMetric, a.otelCfg.ErrorFilter(filter), label, rangeStr)
	p95Q := otelconfig.Quantile(0.95, durationBucket, filter, label, a.otelCfg.Labels.Le, rangeStr)
	p99Q := otelconfig.Quantile(0.99, durationBucket, filter, label, a.otelCfg.Labels.Le, rangeStr)

	resultMap := a.runInstantQueries(ctx, at, []QueryJob{
		{"rate", rateQ},
		{"error", errorQ},
		{"p95", p95Q},
		{"p99", p99Q},
	}, logger)

	rows := make(map[string]*TraceBreakdownRow)
	get := func(r queries.PromResult) *TraceBreakdownRow {
		value := r.Metric[label]
		row, ok := rows[value]
		if !ok {
			row = &TraceBreakdownRow{Value: value}
			rows[value] = row
		}
		return row
	}
	for _, r := range resultMap["rate"] {
		if r.Metric[label] == "" {
			continue
		}
		get(r).Rate = roundTo(r.Value.Float(), 3)
	}
	for _, r := range resultMap["error"] {
		if r.Metric[label] == "" {
			continue
		}
		row := get(r)
		row.ErrorRate = calculateErrorRate(r.Value.Float(), row.Rate)
	}
	toMs := func(v float64) float64 {
		if durationUnit == "s" {
			return v * 1000
		}
		return v
	}
	for _, r := range resultMap["p95"] {
		if r.Metric[label] == "" {
			continue
		}
		if v := r.Value.Float(); isValidMetricValue(v) {
			get(r).P95Ms = roundTo(toMs(v), 2)
		}
	}
	for _, r := range resultMap["p99"] {
		if r.Metric[label] == "" {
			continue
		}
		if v := r.Value.Float(); isValidMetricValue(v) {
			get(r).P99Ms = roundTo(toMs(v), 2)
		}
	}

	out := make([]TraceBreakdownRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].P99Ms != out[j].P99Ms {
			return out[i].P99Ms > out[j].P99Ms
		}
		return out[i].Value < out[j].Value
	})

	// Fallback dimension availability: name is always offered; the requested
	// dimension is offered when it produced rows.
	dimSet := map[string]bool{"name": true}
	if len(out) > 0 {
		dimSet[dimension] = true
	}
	dims := make([]string, 0, len(traceDimensions))
	for _, d := range traceDimensions {
		if dimSet[d.key] {
			dims = append(dims, d.key)
		}
	}
	return dims, out
}
