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

func (a *App) handleOperations(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	namespace, service := parseServiceRef(req)
	environment := parseEnvironment(req)

	if !requireServiceParam(w, service) {
		return
	}

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.SpanMetrics.Detected {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("[]"))
		return
	}

	from, to := parseTimeRange(req)
	operations := a.queryOperations(ctx, caps, namespace, service, environment, from, to)
	writeJSON(w, operations)
}

func (a *App) queryOperations(
	ctx context.Context,
	caps queries.Capabilities,
	namespace, service, environment string,
	_, to time.Time,
) []queries.OperationSummary {
	logger := log.DefaultLogger.With("handler", "operations")
	callsMetric := caps.SpanMetrics.CallsMetric
	durationUnit := caps.SpanMetrics.DurationUnit
	durationBucket := caps.SpanMetrics.DurationMetric

	rangeStr := "[5m]"

	// Build label filter
	labelFilter := a.otelCfg.ServiceFilter(service, namespace)
	if environment != "" {
		labelFilter += fmt.Sprintf(`, %s="%s"`, a.otelCfg.Labels.DeploymentEnv, environment)
	}

	groupBy := a.otelCfg.Labels.SpanName + ", " + a.otelCfg.Labels.SpanKind
	rateQuery := otelconfig.Rate(callsMetric, labelFilter, groupBy, rangeStr)
	errorQuery := otelconfig.Rate(callsMetric, a.otelCfg.ErrorFilter(labelFilter), groupBy, rangeStr)
	p50Query := otelconfig.Quantile(0.50, durationBucket, labelFilter, groupBy, a.otelCfg.Labels.Le, rangeStr)
	p95Query := otelconfig.Quantile(0.95, durationBucket, labelFilter, groupBy, a.otelCfg.Labels.Le, rangeStr)
	p99Query := otelconfig.Quantile(0.99, durationBucket, labelFilter, groupBy, a.otelCfg.Labels.Le, rangeStr)

	resultMap := a.runInstantQueries(ctx, to, []QueryJob{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p50", p50Query},
		{"p95", p95Query},
		{"p99", p99Query},
	}, logger)

	type opKey struct {
		spanName string
		spanKind string
	}

	opsMap := make(map[opKey]*queries.OperationSummary)
	getOrCreate := func(r queries.PromResult) *queries.OperationSummary {
		k := opKey{
			spanName: r.Metric[a.otelCfg.Labels.SpanName],
			spanKind: r.Metric[a.otelCfg.Labels.SpanKind],
		}
		if o, ok := opsMap[k]; ok {
			return o
		}
		o := &queries.OperationSummary{
			SpanName:     k.spanName,
			SpanKind:     a.otelCfg.FormatSpanKind(k.spanKind),
			DurationUnit: durationUnit,
		}
		opsMap[k] = o
		return o
	}

	for _, r := range resultMap["rate"] {
		o := getOrCreate(r)
		o.Rate = roundTo(r.Value.Float(), 3)
	}

	for _, r := range resultMap["error"] {
		o := getOrCreate(r)
		o.ErrorRate = calculateErrorRate(r.Value.Float(), o.Rate)
	}

	for _, r := range resultMap["p50"] {
		o := getOrCreate(r)
		v := r.Value.Float()
		if isValidMetricValue(v) {
			o.P50Duration = roundTo(v, 2)
		}
	}
	for _, r := range resultMap["p95"] {
		o := getOrCreate(r)
		v := r.Value.Float()
		if isValidMetricValue(v) {
			o.P95Duration = roundTo(v, 2)
		}
	}
	for _, r := range resultMap["p99"] {
		o := getOrCreate(r)
		v := r.Value.Float()
		if isValidMetricValue(v) {
			o.P99Duration = roundTo(v, 2)
		}
	}

	ops := make([]queries.OperationSummary, 0, len(opsMap))
	for _, o := range opsMap {
		ops = append(ops, *o)
	}
	return ops
}


