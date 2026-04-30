package plugin

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// HealthSummary provides aggregate health stats for a service,
// including comparison to a previous period for delta/anomaly detection.
type HealthSummary struct {
	Rate         float64 `json:"rate"`
	ErrorRate    float64 `json:"errorRate"`
	P95Duration  float64 `json:"p95Duration"`
	DurationUnit string  `json:"durationUnit"`

	// Previous-period values (same window size, offset by window duration).
	// Null (pointer) when baseline data is unavailable.
	PrevRate        *float64 `json:"prevRate"`
	PrevErrorRate   *float64 `json:"prevErrorRate"`
	PrevP95Duration *float64 `json:"prevP95Duration"`

	// Degraded operations: only those exceeding anomaly thresholds.
	DegradedOps []DegradedOperation `json:"degradedOps,omitempty"`

	// Degraded dependencies: only those exceeding anomaly thresholds.
	DegradedDeps []DegradedDependency `json:"degradedDeps,omitempty"`

	// CauseCategory indicates the likely root-cause direction when degradation exists.
	//   "downstream-likely"       — dependency error volume explains a significant share of service errors
	//   "mixed"                   — both ops and deps degraded but correlation is weak
	//   "no-downstream-detected"  — ops degraded but no dependency issues found (may be incomplete)
	//   "downstream-only"         — deps degraded but service operations appear unaffected
	//   ""                        — nothing degraded
	CauseCategory string `json:"causeCategory,omitempty"`
}

// DegradedOperation is an operation with a significant regression vs the previous period.
type DegradedOperation struct {
	SpanName     string  `json:"spanName"`
	SpanKind     string  `json:"spanKind"`
	Rate         float64 `json:"rate"`
	ErrorRate    float64 `json:"errorRate"`
	P95Duration  float64 `json:"p95Duration"`
	DurationUnit string  `json:"durationUnit"`

	PrevErrorRate   float64 `json:"prevErrorRate"`
	PrevP95Duration float64 `json:"prevP95Duration"`

	// Which dimension triggered the anomaly.
	ErrorAnomaly   bool `json:"errorAnomaly,omitempty"`
	LatencyAnomaly bool `json:"latencyAnomaly,omitempty"`
}

// DegradedDependency is a downstream dependency with elevated error/latency.
type DegradedDependency struct {
	Name         string  `json:"name"`
	Type         string  `json:"type"`
	Rate         float64 `json:"rate"`
	ErrorRate    float64 `json:"errorRate"`
	P95Duration  float64 `json:"p95Duration"`
	DurationUnit string  `json:"durationUnit"`

	PrevErrorRate   float64 `json:"prevErrorRate"`
	PrevP95Duration float64 `json:"prevP95Duration"`

	ErrorAnomaly   bool `json:"errorAnomaly,omitempty"`
	LatencyAnomaly bool `json:"latencyAnomaly,omitempty"`
}

// Anomaly detection thresholds.
const (
	// Minimum request rate (req/s) to consider an operation/dependency for anomaly detection.
	anomalyMinRate = 0.1
	// Minimum absolute error rate increase (percentage points) to flag as a delta anomaly.
	anomalyMinErrorIncrease = 2.0
	// Minimum relative factor to flag (current/prev).
	anomalyRelativeFactor = 2.0
	// Minimum absolute latency increase (ms) to flag.
	anomalyMinLatencyIncreaseMs = 50.0
	// Absolute error rate threshold (%) — flag regardless of delta.
	absoluteErrorCritical = 5.0
)

func (a *App) handleHealth(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	namespace, service := parseServiceRef(req)
	environment := parseEnvironment(req)
	serverOnly := req.URL.Query().Get("serverSpans") == "true"

	if !requireServiceParam(w, service) {
		return
	}

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.SpanMetrics.Detected {
		writeJSON(w, HealthSummary{DurationUnit: "ms"})
		return
	}

	from, to := parseTimeRange(req)
	summary := a.queryHealth(ctx, caps, namespace, service, environment, from, to, serverOnly)
	writeJSON(w, summary)
}

func (a *App) queryHealth(
	ctx context.Context,
	caps queries.Capabilities,
	namespace, service, environment string,
	from, to time.Time,
	serverOnly bool,
) HealthSummary {
	logger := log.DefaultLogger.With("handler", "health")
	callsMetric := caps.SpanMetrics.CallsMetric
	durationUnit := caps.SpanMetrics.DurationUnit
	durationBucket := caps.SpanMetrics.DurationMetric

	// Use the selected time range to determine the rate window.
	// Cap at a reasonable minimum (1m) and maximum (1h).
	rangeDuration := to.Sub(from)
	if rangeDuration < time.Minute {
		rangeDuration = time.Minute
	}
	if rangeDuration > time.Hour {
		rangeDuration = time.Hour
	}
	rangeStr := fmt.Sprintf("[%ds]", int(rangeDuration.Seconds()))

	// Offset for comparison: same window shifted back by 1x the range.
	// E.g., if viewing last 15m, compare to the 15m before that.
	// Minimum offset is the window itself; for very short windows use 1h.
	offsetDuration := rangeDuration
	if offsetDuration < time.Hour {
		offsetDuration = time.Hour
	}
	offsetStr := fmt.Sprintf(" offset %ds", int(offsetDuration.Seconds()))

	// Build label filters — match the scope used by RED panels.
	// When serverOnly is true (service has SERVER spans), restrict to SERVER kind.
	// Otherwise, use all span kinds like the RED panels do.
	var svcFilter string
	if serverOnly {
		svcFilter = a.otelCfg.ServerFilter(service, namespace)
	} else {
		svcFilter = a.otelCfg.ServiceFilter(service, namespace)
	}
	if environment != "" {
		svcFilter += fmt.Sprintf(`, %s="%s"`, a.otelCfg.Labels.DeploymentEnv, environment)
	}

	// --- Aggregate health queries ---
	currentRate := otelconfig.Rate(callsMetric, svcFilter, "", rangeStr)
	currentError := otelconfig.Rate(callsMetric, a.otelCfg.ErrorFilter(svcFilter), "", rangeStr)
	currentP95 := otelconfig.Quantile(0.95, durationBucket, svcFilter, "", a.otelCfg.Labels.Le, rangeStr)

	prevRate := wrapOffset(otelconfig.Rate(callsMetric, svcFilter, "", rangeStr), offsetStr)
	prevError := wrapOffset(otelconfig.Rate(callsMetric, a.otelCfg.ErrorFilter(svcFilter), "", rangeStr), offsetStr)
	prevP95 := wrapOffset(otelconfig.Quantile(0.95, durationBucket, svcFilter, "", a.otelCfg.Labels.Le, rangeStr), offsetStr)

	// --- Per-operation queries (for anomaly detection) ---
	groupBy := a.otelCfg.Labels.SpanName + ", " + a.otelCfg.Labels.SpanKind
	opRate := otelconfig.Rate(callsMetric, svcFilter, groupBy, rangeStr)
	opError := otelconfig.Rate(callsMetric, a.otelCfg.ErrorFilter(svcFilter), groupBy, rangeStr)
	opP95 := otelconfig.Quantile(0.95, durationBucket, svcFilter, groupBy, a.otelCfg.Labels.Le, rangeStr)
	opPrevRate := wrapOffset(otelconfig.Rate(callsMetric, svcFilter, groupBy, rangeStr), offsetStr)
	opPrevError := wrapOffset(otelconfig.Rate(callsMetric, a.otelCfg.ErrorFilter(svcFilter), groupBy, rangeStr), offsetStr)
	opPrevP95 := wrapOffset(otelconfig.Quantile(0.95, durationBucket, svcFilter, groupBy, a.otelCfg.Labels.Le, rangeStr), offsetStr)

	resultMap := a.runInstantQueries(ctx, to, []QueryJob{
		{"rate", currentRate},
		{"error", currentError},
		{"p95", currentP95},
		{"prevRate", prevRate},
		{"prevError", prevError},
		{"prevP95", prevP95},
		{"opRate", opRate},
		{"opError", opError},
		{"opP95", opP95},
		{"opPrevRate", opPrevRate},
		{"opPrevError", opPrevError},
		{"opPrevP95", opPrevP95},
	}, logger)

	summary := HealthSummary{DurationUnit: durationUnit}

	// Aggregate stats
	if r := singleValue(resultMap["rate"]); r != nil {
		summary.Rate = roundTo(*r, 3)
	}
	if r := singleValue(resultMap["error"]); r != nil {
		summary.ErrorRate = calculateErrorRate(*r, summary.Rate)
	}
	if r := singleValue(resultMap["p95"]); r != nil && isValidMetricValue(*r) {
		summary.P95Duration = roundTo(*r, 2)
	}

	if r := singleValue(resultMap["prevRate"]); r != nil {
		v := roundTo(*r, 3)
		summary.PrevRate = &v
	}
	if r := singleValue(resultMap["prevError"]); r != nil && summary.PrevRate != nil {
		v := calculateErrorRate(*r, *summary.PrevRate)
		summary.PrevErrorRate = &v
	}
	if r := singleValue(resultMap["prevP95"]); r != nil && isValidMetricValue(*r) {
		v := roundTo(*r, 2)
		summary.PrevP95Duration = &v
	}

	// Per-operation anomaly detection
	summary.DegradedOps = a.detectDegradedOps(resultMap, durationUnit)

	// Degraded dependencies (from service graph if available)
	if caps.ServiceGraph.Detected {
		summary.DegradedDeps = a.queryDegradedDeps(ctx, caps, service, environment, to, rangeStr, offsetStr, durationUnit, logger)
	}

	// Causality analysis: correlate degraded ops with degraded deps.
	summary.CauseCategory = classifyCause(summary)

	return summary
}

func (a *App) detectDegradedOps(resultMap map[string][]queries.PromResult, durationUnit string) []DegradedOperation {
	type opKey struct{ name, kind string }
	type opData struct {
		rate, errorRate, p95         float64
		prevRate, prevErrorRate, prevP95 float64
		hasPrevRate, hasPrevError, hasPrevP95 bool
	}

	ops := make(map[opKey]*opData)
	getOp := func(r queries.PromResult) *opData {
		k := opKey{
			name: r.Metric[a.otelCfg.Labels.SpanName],
			kind: r.Metric[a.otelCfg.Labels.SpanKind],
		}
		if o, ok := ops[k]; ok {
			return o
		}
		o := &opData{}
		ops[k] = o
		return o
	}

	for _, r := range resultMap["opRate"] {
		getOp(r).rate = r.Value.Float()
	}
	for _, r := range resultMap["opError"] {
		o := getOp(r)
		o.errorRate = calculateErrorRate(r.Value.Float(), o.rate)
	}
	for _, r := range resultMap["opP95"] {
		v := r.Value.Float()
		if isValidMetricValue(v) {
			getOp(r).p95 = v
		}
	}
	for _, r := range resultMap["opPrevRate"] {
		o := getOp(r)
		o.prevRate = r.Value.Float()
		o.hasPrevRate = true
	}
	for _, r := range resultMap["opPrevError"] {
		o := getOp(r)
		// Use previous period's rate as denominator for accurate baseline error rate
		denom := o.prevRate
		if !o.hasPrevRate || denom == 0 {
			denom = o.rate
		}
		o.prevErrorRate = calculateErrorRate(r.Value.Float(), denom)
		o.hasPrevError = true
	}
	for _, r := range resultMap["opPrevP95"] {
		v := r.Value.Float()
		if isValidMetricValue(v) {
			o := getOp(r)
			o.prevP95 = v
			o.hasPrevP95 = true
		}
	}

	var degraded []DegradedOperation
	for k, o := range ops {
		if o.rate < anomalyMinRate {
			continue
		}

		// Delta-based: error rate increased significantly vs previous period.
		isErrorDelta := o.hasPrevError &&
			o.errorRate > 0 &&
			(o.errorRate-o.prevErrorRate) >= anomalyMinErrorIncrease &&
			(o.prevErrorRate == 0 || o.errorRate/o.prevErrorRate >= anomalyRelativeFactor)

		// Absolute: error rate is critically high regardless of change.
		isErrorAbsolute := o.errorRate >= absoluteErrorCritical

		isErrorAnomaly := isErrorDelta || isErrorAbsolute

		p95Ms := toMs(o.p95, durationUnit)
		prevP95Ms := toMs(o.prevP95, durationUnit)
		isLatencyAnomaly := o.hasPrevP95 &&
			o.p95 > 0 && o.prevP95 > 0 &&
			(p95Ms-prevP95Ms) >= anomalyMinLatencyIncreaseMs &&
			p95Ms/prevP95Ms >= anomalyRelativeFactor

		if isErrorAnomaly || isLatencyAnomaly {
			degraded = append(degraded, DegradedOperation{
				SpanName:        k.name,
				SpanKind:        a.otelCfg.FormatSpanKind(k.kind),
				Rate:            roundTo(o.rate, 3),
				ErrorRate:       roundTo(o.errorRate, 1),
				P95Duration:     roundTo(o.p95, 2),
				DurationUnit:    durationUnit,
				PrevErrorRate:   roundTo(o.prevErrorRate, 1),
				PrevP95Duration: roundTo(o.prevP95, 2),
				ErrorAnomaly:    isErrorAnomaly,
				LatencyAnomaly:  isLatencyAnomaly,
			})
		}
	}
	return degraded
}

func (a *App) queryDegradedDeps(
	ctx context.Context,
	caps queries.Capabilities,
	service, environment string,
	at time.Time,
	rangeStr, offsetStr, durationUnit string,
	logger log.Logger,
) []DegradedDependency {
	cfg := a.otelCfg
	sgp := caps.ServiceGraph.Prefix
	serverLabel := cfg.Labels.Server
	envLabelFilter := ""
	if environment != "" {
		envLabelFilter = fmt.Sprintf(`, %s="%s"`, cfg.Labels.DeploymentEnv, environment)
	}

	depRate := fmt.Sprintf(
		`sum by (%s) (rate(%s%s{%s="%s"%s}%s))`,
		serverLabel, sgp, cfg.ServiceGraph.RequestTotal,
		cfg.Labels.Client, service, envLabelFilter, rangeStr,
	)
	depFailed := fmt.Sprintf(
		`sum by (%s) (rate(%s%s{%s="%s"%s}%s))`,
		serverLabel, sgp, cfg.ServiceGraph.RequestFailedTotal,
		cfg.Labels.Client, service, envLabelFilter, rangeStr,
	)
	depP95 := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s) (rate(%s%s{%s="%s"%s}%s)))`,
		serverLabel, cfg.Labels.Le, sgp, cfg.ServiceGraph.RequestServerBucket,
		cfg.Labels.Client, service, envLabelFilter, rangeStr,
	)
	depPrevRate := wrapOffset(fmt.Sprintf(
		`sum by (%s) (rate(%s%s{%s="%s"%s}%s))`,
		serverLabel, sgp, cfg.ServiceGraph.RequestTotal,
		cfg.Labels.Client, service, envLabelFilter, rangeStr,
	), offsetStr)
	depPrevFailed := wrapOffset(fmt.Sprintf(
		`sum by (%s) (rate(%s%s{%s="%s"%s}%s))`,
		serverLabel, sgp, cfg.ServiceGraph.RequestFailedTotal,
		cfg.Labels.Client, service, envLabelFilter, rangeStr,
	), offsetStr)
	depPrevP95 := wrapOffset(fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s) (rate(%s%s{%s="%s"%s}%s)))`,
		serverLabel, cfg.Labels.Le, sgp, cfg.ServiceGraph.RequestServerBucket,
		cfg.Labels.Client, service, envLabelFilter, rangeStr,
	), offsetStr)

	resultMap := a.runInstantQueries(ctx, at, []QueryJob{
		{"depRate", depRate},
		{"depFailed", depFailed},
		{"depP95", depP95},
		{"depPrevRate", depPrevRate},
		{"depPrevFailed", depPrevFailed},
		{"depPrevP95", depPrevP95},
	}, logger)

	type depData struct {
		rate, errorRate, p95             float64
		prevRate, prevErrorRate, prevP95 float64
		hasPrevRate, hasPrevError, hasPrevP95 bool
	}

	deps := make(map[string]*depData)
	getDep := func(r queries.PromResult) *depData {
		name := r.Metric[cfg.Labels.Server]
		if d, ok := deps[name]; ok {
			return d
		}
		d := &depData{}
		deps[name] = d
		return d
	}

	for _, r := range resultMap["depRate"] {
		getDep(r).rate = r.Value.Float()
	}
	for _, r := range resultMap["depFailed"] {
		d := getDep(r)
		d.errorRate = calculateErrorRate(r.Value.Float(), d.rate)
	}
	for _, r := range resultMap["depP95"] {
		v := r.Value.Float()
		if isValidMetricValue(v) {
			getDep(r).p95 = v
		}
	}
	for _, r := range resultMap["depPrevRate"] {
		d := getDep(r)
		d.prevRate = r.Value.Float()
		d.hasPrevRate = true
	}
	for _, r := range resultMap["depPrevFailed"] {
		d := getDep(r)
		// Use previous period's rate as denominator for accurate baseline error rate
		denom := d.prevRate
		if !d.hasPrevRate || denom == 0 {
			denom = d.rate
		}
		d.prevErrorRate = calculateErrorRate(r.Value.Float(), denom)
		d.hasPrevError = true
	}
	for _, r := range resultMap["depPrevP95"] {
		v := r.Value.Float()
		if isValidMetricValue(v) {
			d := getDep(r)
			d.prevP95 = v
			d.hasPrevP95 = true
		}
	}

	var degraded []DegradedDependency
	for name, d := range deps {
		if d.rate < anomalyMinRate {
			continue
		}

		// Delta-based: error rate increased significantly vs previous period.
		isErrorDelta := d.hasPrevError &&
			d.errorRate > 0 &&
			(d.errorRate-d.prevErrorRate) >= anomalyMinErrorIncrease &&
			(d.prevErrorRate == 0 || d.errorRate/d.prevErrorRate >= anomalyRelativeFactor)

		// Absolute: error rate is critically high regardless of change.
		isErrorAbsolute := d.errorRate >= absoluteErrorCritical

		isErrorAnomaly := isErrorDelta || isErrorAbsolute

		p95Ms := toMs(d.p95, durationUnit)
		prevP95Ms := toMs(d.prevP95, durationUnit)
		isLatencyAnomaly := d.hasPrevP95 &&
			d.p95 > 0 && d.prevP95 > 0 &&
			(p95Ms-prevP95Ms) >= anomalyMinLatencyIncreaseMs &&
			p95Ms/prevP95Ms >= anomalyRelativeFactor

		if isErrorAnomaly || isLatencyAnomaly {
			degraded = append(degraded, DegradedDependency{
				Name:            name,
				Type:            "service",
				Rate:            roundTo(d.rate, 3),
				ErrorRate:       roundTo(d.errorRate, 1),
				P95Duration:     roundTo(d.p95, 2),
				DurationUnit:    durationUnit,
				PrevErrorRate:   roundTo(d.prevErrorRate, 1),
				PrevP95Duration: roundTo(d.prevP95, 2),
				ErrorAnomaly:    isErrorAnomaly,
				LatencyAnomaly:  isLatencyAnomaly,
			})
		}
	}
	return degraded
}

// classifyCause determines the likely root-cause direction by correlating
// degraded operations with degraded dependencies using volumetric analysis.
//
// When both ops and deps are degraded, it compares the error volume (errors/sec)
// from degraded dependencies against the service's total error volume.
// If dependency errors account for ≥30% of service errors, the failures are
// "downstream-likely" (cascading from dependencies).
func classifyCause(s HealthSummary) string {
	hasOps := len(s.DegradedOps) > 0
	hasDeps := len(s.DegradedDeps) > 0

	if !hasOps && !hasDeps {
		return ""
	}
	if hasOps && !hasDeps {
		return "no-downstream-detected"
	}
	if !hasOps && hasDeps {
		return "downstream-only"
	}

	// Both present — compare error volumes.
	svcErrorVolume := s.Rate * s.ErrorRate / 100.0

	var depErrorVolume float64
	for _, dep := range s.DegradedDeps {
		if dep.ErrorAnomaly {
			depErrorVolume += dep.Rate * dep.ErrorRate / 100.0
		}
	}

	// If dependency error volume explains ≥30% of service error volume,
	// the failures are likely cascading from downstream.
	const downstreamThreshold = 0.3
	if svcErrorVolume > 0 && depErrorVolume >= svcErrorVolume*downstreamThreshold {
		return "downstream-likely"
	}

	return "mixed"
}

// wrapOffset injects " offset Xs" into existing PromQL range vectors.
// It transforms `rate(metric{filter}[5m])` → `rate(metric{filter}[5m] offset 1h)`.
func wrapOffset(query, offset string) string {
	// Find the closing bracket of the range vector and insert the offset before it.
	// Pattern: ...][...]) → ...] offset Xs[...])
	// We need to insert after the "]" that follows the range specifier.
	result := make([]byte, 0, len(query)+len(offset))
	depth := 0
	inserted := false
	for i := 0; i < len(query); i++ {
		b := query[i]
		result = append(result, b)
		if b == '[' {
			depth++
		}
		if b == ']' && depth > 0 {
			depth--
			if !inserted {
				result = append(result, []byte(offset)...)
				inserted = true
			}
		}
	}
	return string(result)
}

// singleValue extracts the first scalar value from a PromQL instant query result.
func singleValue(results []queries.PromResult) *float64 {
	if len(results) == 0 {
		return nil
	}
	v := results[0].Value.Float()
	return &v
}

// toMs converts a duration value to milliseconds.
func toMs(val float64, unit string) float64 {
	if unit == "s" {
		return val * 1000
	}
	return val
}
