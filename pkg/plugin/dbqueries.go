package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// Top queries — Database tab Phase 2 (issue #119 §4.2).
//
// Sourced from Tempo, not metrics: only traces carry db.statement. Because
// Tempo is cost-sensitive (§6, LGTM audit) the query is bounded hard —
// per-service, a capped window, a span/trace limit — and cached. It runs
// on-demand (section open), never continuously.
//
// Every statement is normalized server-side (see dbnormalize.go) before it is
// aggregated or returned; raw literals never reach the UI.

const (
	// topQueriesWindowCap bounds the TraceQL search window. A wider selected
	// range is clamped to the most-recent slice of this size to keep Tempo cost
	// predictable. Tunable.
	topQueriesWindowCap = time.Hour
	// topQueriesTraceLimit caps traces scanned; topQueriesSpansPerSet caps DB
	// spans pulled per trace. Together they bound the sample the aggregation
	// sees (and the bytes Tempo inspects). Tunable.
	topQueriesTraceLimit  = 200
	topQueriesSpansPerSet = 10
	// topQueriesMaxRows caps the normalized groups returned to the UI.
	topQueriesMaxRows = 50
	// topQueriesTimeout bounds the single Tempo search call end-to-end.
	topQueriesTimeout = 25 * time.Second
)

// TopQuery is one normalized statement with its aggregated metrics over the
// sampled spans. Statement is always the normalized fingerprint (never raw).
type TopQuery struct {
	Statement   string  `json:"statement"`
	DBSystem    string  `json:"dbSystem"`
	Table       string  `json:"table,omitempty"`
	Count       int     `json:"count"`
	TotalTimeMs float64 `json:"totalTimeMs"`
	AvgTimeMs   float64 `json:"avgTimeMs"`
	P95Ms       float64 `json:"p95Ms"`
	// TraceID links to a representative trace containing this query.
	TraceID string `json:"traceId,omitempty"`
}

// TopQueriesResponse is the /database/queries payload. The UI re-sorts the one
// list by the three PRD lenses (total time, count, p95).
type TopQueriesResponse struct {
	// Mode is "traceql" when Tempo answered, else "unavailable".
	Mode    string     `json:"mode"`
	Queries []TopQuery `json:"queries"`
	// Sampled is the number of DB spans the aggregation saw.
	Sampled int `json:"sampled"`
	// Truncated is true when the trace limit was hit (results are a sample).
	Truncated bool `json:"truncated"`
	// WindowSeconds is the effective (possibly clamped) window queried.
	WindowSeconds int    `json:"windowSeconds"`
	Note          string `json:"note,omitempty"`
}

// handleDatabaseQueries returns the top normalized DB statements for a service,
// aggregated from a bounded Tempo trace search.
// GET /services/{namespace}/{service}/database/queries?from=&to=&tracesUid=
func (a *App) handleDatabaseQueries(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	namespace, service := parseServiceRef(req)
	if !requireServiceParam(w, service) {
		return
	}
	from, to := parseTimeRange(req)
	// Cost bound: clamp the window to the most-recent cap.
	from = clampWindow(from, to, topQueriesWindowCap)

	tracesUID := sanitizeDatasourceUID(req.URL.Query().Get("tracesUid"))
	// Confused-deputy hardening: only the configured traces datasource(s) may be
	// proxied with the SA token (mirrors handleTraceBreakdown).
	if tracesUID == "" || !a.settings.TracesDataSource.Allows(tracesUID) {
		writeJSON(w, TopQueriesResponse{Mode: "unavailable", Queries: []TopQuery{}, Note: "traces datasource not configured"})
		return
	}

	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("dbqueries", orgID, roundedUnix(from), roundedUnix(to), namespace, service, tracesUID)
	headers := req.Header
	a.writeCached(w, ck, "querying top database queries failed", func() (any, error) {
		return a.queryTopDatabaseQueries(ctx, headers, tracesUID, namespace, service, from, to), nil
	})
}

// clampWindow returns a from no earlier than to-cap, so a wide selected range
// only ever hits Tempo for the most-recent cap-sized slice.
//
//nolint:unparam // cap is a per-feature tunable window bound (top-queries and the N+1 scan both currently pass 1h).
func clampWindow(from, to time.Time, cap time.Duration) time.Time {
	if earliest := to.Add(-cap); from.Before(earliest) {
		return earliest
	}
	return from
}

// queryTopDatabaseQueries runs the bounded Tempo search, normalizes + aggregates
// the DB spans, and returns the top-N normalized statements. Degrades to an
// "unavailable" response (never hangs) when Tempo errors or times out.
func (a *App) queryTopDatabaseQueries(ctx context.Context, headers http.Header, tracesUID, namespace, service string, from, to time.Time) TopQueriesResponse {
	logger := log.DefaultLogger.With("handler", "database-queries")
	windowSec := int(to.Sub(from).Seconds())

	spans, truncated, err := a.searchDBSpans(ctx, headers, tracesUID, namespace, service, from, to)
	if err != nil {
		logger.Warn("Tempo DB span search failed", "service", sanitizeLogValue(service), "error", err)
		return TopQueriesResponse{
			Mode: "unavailable", Queries: []TopQuery{}, WindowSeconds: windowSec,
			Note: "trace search unavailable (Tempo may be busy) — try a narrower range",
		}
	}

	queries := aggregateTopQueries(spans, topQueriesMaxRows)
	return TopQueriesResponse{
		Mode:          "traceql",
		Queries:       queries,
		Sampled:       len(spans),
		Truncated:     truncated,
		WindowSeconds: windowSec,
	}
}

// dbSpan is one DB client span extracted from the trace search.
type dbSpan struct {
	system     string
	statement  string // raw; normalized during aggregation
	table      string
	durationMs float64
	traceID    string
}

// aggregateTopQueries normalizes each span's statement, groups by the
// (normalized statement, db.system) pair, and returns the top-N groups by total
// time. p95 is computed from the sampled durations of each group.
func aggregateTopQueries(spans []dbSpan, limit int) []TopQuery {
	type group struct {
		system    string
		table     string
		traceID   string
		durations []float64
		total     float64
	}
	groups := make(map[string]*group)
	for _, s := range spans {
		norm := normalizeStatement(s.system, s.statement)
		if norm == "" {
			continue
		}
		key := s.system + "\x00" + norm
		g := groups[key]
		if g == nil {
			g = &group{system: s.system, table: s.table, traceID: s.traceID}
			groups[key] = g
		}
		if g.table == "" && s.table != "" {
			g.table = s.table
		}
		if g.traceID == "" && s.traceID != "" {
			g.traceID = s.traceID
		}
		g.durations = append(g.durations, s.durationMs)
		g.total += s.durationMs
	}

	out := make([]TopQuery, 0, len(groups))
	for key, g := range groups {
		// The normalized statement is the second half of the composite key.
		norm := key[len(g.system)+1:]
		count := len(g.durations)
		out = append(out, TopQuery{
			Statement:   norm,
			DBSystem:    g.system,
			Table:       g.table,
			Count:       count,
			TotalTimeMs: roundTo(g.total, 2),
			AvgTimeMs:   roundTo(g.total/float64(count), 2),
			P95Ms:       roundTo(percentile95(g.durations), 2),
			TraceID:     g.traceID,
		})
	}
	// Default ordering: by total time desc (the "which costs the most" lens).
	// The UI re-sorts by count / p95 client-side.
	sort.Slice(out, func(i, j int) bool {
		if out[i].TotalTimeMs != out[j].TotalTimeMs {
			return out[i].TotalTimeMs > out[j].TotalTimeMs
		}
		return out[i].Statement < out[j].Statement
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// percentile95 returns the p95 of vals using nearest-rank on a sorted copy.
// Computed from the sampled durations of a normalized group (the PRD's "tail"
// lens). Returns 0 for an empty input.
func percentile95(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	sorted := make([]float64, len(vals))
	copy(sorted, vals)
	sort.Float64s(sorted)
	rank := int(float64(len(sorted)-1) * 0.95)
	if rank < 0 {
		rank = 0
	}
	if rank >= len(sorted) {
		rank = len(sorted) - 1
	}
	return sorted[rank]
}

// ---------------------------------------------------------------------------
// Tempo native search (spanset attributes via select())
// ---------------------------------------------------------------------------

// searchDBSpans runs one bounded TraceQL search for this service's DB client
// spans through Grafana's datasource proxy, pulling db.statement/system/table
// and duration per span via select(). Returns the flattened spans and whether
// the trace limit was hit (result is a sample).
func (a *App) searchDBSpans(ctx context.Context, headers http.Header, tracesUID, namespace, service string, from, to time.Time) ([]dbSpan, bool, error) {
	base := a.proxyURL(tracesUID)
	if base == "" {
		return nil, false, fmt.Errorf("traces datasource not configured")
	}

	svc := a.otelCfg.TraceQL.ServiceName
	query := fmt.Sprintf(`{ %s = %q && span.db.system != "" }`, svc, service)
	if namespace != "" {
		query = fmt.Sprintf(`{ %s = %q && %s = %q && span.db.system != "" }`,
			svc, service, a.otelCfg.TraceQL.ServiceNamespace, namespace)
	}
	query += ` | select(span.db.statement, span.db.system, span.db.sql.table)`

	q := url.Values{
		"q":     {query},
		"limit": {strconv.Itoa(topQueriesTraceLimit)},
		"spss":  {strconv.Itoa(topQueriesSpansPerSet)},
		"start": {strconv.FormatInt(from.Unix(), 10)},
		"end":   {strconv.FormatInt(to.Unix(), 10)},
	}
	reqURL := base + "/api/search?" + q.Encode()

	ctx, cancel := context.WithTimeout(ctx, topQueriesTimeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, false, err
	}
	applyProxyAuth(httpReq, headers, a.resolveServiceToken(ctx))

	client := &http.Client{Timeout: topQueriesTimeout}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, false, err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close() //nolint:errcheck
	}()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, false, fmt.Errorf("tempo search returned HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, false, err
	}
	spans, traceCount := parseDBSearchResponse(body)
	return spans, traceCount >= topQueriesTraceLimit, nil
}

// tempoSearchResponse is the subset of Tempo's /api/search JSON we consume.
// RootServiceName/RootTraceName identify the request the trace belongs to; the
// N+1 scan (dbnplusone.go) uses them to name the offending endpoint. Top-queries
// ignores them.
type tempoSearchResponse struct {
	Traces []struct {
		TraceID         string         `json:"traceID"`
		RootServiceName string         `json:"rootServiceName"`
		RootTraceName   string         `json:"rootTraceName"`
		SpanSet         *tempoSpanSet  `json:"spanSet"`
		SpanSets        []tempoSpanSet `json:"spanSets"`
	} `json:"traces"`
}

type tempoSpanSet struct {
	Spans []tempoSearchSpan `json:"spans"`
}

type tempoSearchSpan struct {
	SpanID        string `json:"spanID"`
	DurationNanos string `json:"durationNanos"`
	Attributes    []struct {
		Key   string `json:"key"`
		Value struct {
			StringValue string `json:"stringValue"`
		} `json:"value"`
	} `json:"attributes"`
}

// parseDBSearchResponse flattens the search response into dbSpans, deduping by
// spanID (Tempo echoes the same spans under both `spanSet` and `spanSets`).
// Returns the spans and the number of traces seen.
func parseDBSearchResponse(body []byte) ([]dbSpan, int) {
	var parsed tempoSearchResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, 0
	}
	var out []dbSpan
	seen := make(map[string]struct{})
	for _, t := range parsed.Traces {
		sets := t.SpanSets
		if len(sets) == 0 && t.SpanSet != nil {
			sets = []tempoSpanSet{*t.SpanSet}
		}
		for _, ss := range sets {
			for _, sp := range ss.Spans {
				if sp.SpanID != "" {
					if _, dup := seen[sp.SpanID]; dup {
						continue
					}
					seen[sp.SpanID] = struct{}{}
				}
				span := dbSpan{traceID: t.TraceID}
				for _, attr := range sp.Attributes {
					switch attr.Key {
					case "db.statement":
						span.statement = attr.Value.StringValue
					case "db.system":
						span.system = attr.Value.StringValue
					case "db.sql.table":
						span.table = attr.Value.StringValue
					}
				}
				if span.statement == "" {
					continue
				}
				if ns, err := strconv.ParseFloat(sp.DurationNanos, 64); err == nil {
					span.durationMs = ns / 1e6
				}
				out = append(out, span)
			}
		}
	}
	return out, len(parsed.Traces)
}
