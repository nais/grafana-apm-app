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

func (a *App) handleOperations(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := req.Context()
	ctx = withAuthContext(ctx, a.promClientForRequest(req))
	namespace := queries.MustSanitizeLabel(req.PathValue("namespace"))
	service := queries.MustSanitizeLabel(req.PathValue("service"))

	if service == "" {
		http.Error(w, `{"error":"missing service"}`, http.StatusBadRequest)
		return
	}

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.SpanMetrics.Detected {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("[]"))
		return
	}

	now := time.Now()
	from := parseUnixParam(req, "from", now.Add(-1*time.Hour))
	to := parseUnixParam(req, "to", now)
	operations := a.queryOperations(ctx, caps, namespace, service, from, to)
	writeJSON(w, operations)
}

func (a *App) queryOperations(
	ctx context.Context,
	caps queries.Capabilities,
	namespace, service string,
	from, to time.Time,
) []queries.OperationSummary {
	logger := log.DefaultLogger.With("handler", "operations")
	callsMetric := caps.SpanMetrics.CallsMetric
	durationUnit := caps.SpanMetrics.DurationUnit
	durationBucket := caps.SpanMetrics.DurationMetric

	rangeStr := "[5m]"

	// Build label filter
	labelFilter := fmt.Sprintf(`service_name="%s"`, service)
	if namespace != "" {
		labelFilter += fmt.Sprintf(`, service_namespace="%s"`, namespace)
	}

	rateQuery := fmt.Sprintf(
		`sum by (span_name, span_kind) (rate(%s{%s}%s))`,
		callsMetric, labelFilter, rangeStr,
	)
	errorQuery := fmt.Sprintf(
		`sum by (span_name, span_kind) (rate(%s{%s, status_code="STATUS_CODE_ERROR"}%s))`,
		callsMetric, labelFilter, rangeStr,
	)
	p50Query := fmt.Sprintf(
		`histogram_quantile(0.50, sum by (span_name, span_kind, le) (rate(%s{%s}%s)))`,
		durationBucket, labelFilter, rangeStr,
	)
	p95Query := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (span_name, span_kind, le) (rate(%s{%s}%s)))`,
		durationBucket, labelFilter, rangeStr,
	)
	p99Query := fmt.Sprintf(
		`histogram_quantile(0.99, sum by (span_name, span_kind, le) (rate(%s{%s}%s)))`,
		durationBucket, labelFilter, rangeStr,
	)

	type queryResult struct {
		name    string
		results []queries.PromResult
		err     error
	}

	var wg sync.WaitGroup
	ch := make(chan queryResult, 5)

	for _, q := range []struct {
		name  string
		query string
	}{
		{"rate", rateQuery},
		{"error", errorQuery},
		{"p50", p50Query},
		{"p95", p95Query},
		{"p99", p99Query},
	} {
		wg.Add(1)
		go func(n, query string) {
			defer wg.Done()
			results, err := a.prom(ctx).InstantQuery(ctx, query, to)
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
			logger.Warn("Query failed", "query", r.name, "error", r.err)
			continue
		}
		resultMap[r.name] = r.results
	}

	type opKey struct {
		spanName string
		spanKind string
	}

	opsMap := make(map[opKey]*queries.OperationSummary)
	getOrCreate := func(r queries.PromResult) *queries.OperationSummary {
		k := opKey{
			spanName: r.Metric["span_name"],
			spanKind: r.Metric["span_kind"],
		}
		if o, ok := opsMap[k]; ok {
			return o
		}
		o := &queries.OperationSummary{
			SpanName:     k.spanName,
			SpanKind:     formatSpanKind(k.spanKind),
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
		if o.Rate > 0 {
			o.ErrorRate = roundTo(r.Value.Float()/o.Rate*100, 2)
		}
	}

	for _, r := range resultMap["p50"] {
		o := getOrCreate(r)
		v := r.Value.Float()
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			o.P50Duration = roundTo(v, 2)
		}
	}
	for _, r := range resultMap["p95"] {
		o := getOrCreate(r)
		v := r.Value.Float()
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			o.P95Duration = roundTo(v, 2)
		}
	}
	for _, r := range resultMap["p99"] {
		o := getOrCreate(r)
		v := r.Value.Float()
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			o.P99Duration = roundTo(v, 2)
		}
	}

	ops := make([]queries.OperationSummary, 0, len(opsMap))
	for _, o := range opsMap {
		ops = append(ops, *o)
	}
	return ops
}

func formatSpanKind(kind string) string {
	switch kind {
	case "SPAN_KIND_SERVER":
		return "Server"
	case "SPAN_KIND_CLIENT":
		return "Client"
	case "SPAN_KIND_PRODUCER":
		return "Producer"
	case "SPAN_KIND_CONSUMER":
		return "Consumer"
	case "SPAN_KIND_INTERNAL":
		return "Internal"
	default:
		return kind
	}
}
