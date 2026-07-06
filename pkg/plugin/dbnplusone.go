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

// N+1 & query-pattern scan — Database tab Phase 3 (issue #119 §4.3).
//
// This is the "confirm" layer of the two-layer N+1 detection (§4.3): the
// always-on queries-per-request ratio (Phase 1) flags N+1-prone endpoints; this
// on-demand scan pins down the exact offender — "endpoint X ran «query» N× in
// one request" — with a trace link and a per-system remediation hint.
//
// It reuses the Phase 2 plumbing wholesale: the bounded Tempo /api/search proxy
// (searchDBSpans), the response parser's span-attribute extraction, the window
// clamp, the SA-token/datasource-allowlist hardening, the response cache, and —
// critically — the same server-side statement normalization (dbnormalize.go), so
// raw literals never reach the UI (§6, PII-safe).
//
// Cost posture (§6): on-demand only (a "Scan for N+1" action, never a background
// sweep), per-service, window clamped to ≤1h, candidate traces + spans-per-trace
// both capped, a 25s timeout, and the whole result cached. Tempo unavailable →
// a clean "unavailable" state, never a hang.

const (
	// nplusoneWindowCap bounds the TraceQL scan window (clamped to the most
	// recent slice of this size). Matches the top-queries cap.
	nplusoneWindowCap = time.Hour
	// nplusoneRepeatThreshold is the per-trace duplicate-count that makes a
	// normalized statement an N+1 finding: the same fingerprint issued at least
	// this many times inside one request. Tunable (§9). The TraceQL scan pulls
	// candidate traces at count() > repeat-1 (the natural floor — a trace cannot
	// repeat one statement N times without having N db spans), then the exact
	// per-statement grouping is confirmed here in Go.
	nplusoneRepeatThreshold = 10
	// nplusoneTraceLimit caps candidate traces scanned; nplusoneSpansPerSet caps
	// DB spans pulled per trace (must exceed the repeat threshold so the grouping
	// can see the duplicates). Together they bound Tempo cost.
	nplusoneTraceLimit  = 100
	nplusoneSpansPerSet = 100
	// nplusoneMaxFindings caps the findings returned to the UI.
	nplusoneMaxFindings = 50
	// nplusoneTimeout bounds the single Tempo search call end-to-end.
	nplusoneTimeout = 25 * time.Second
)

// NPlusOneFinding is one repeated-query offender inside a single request: the
// normalized statement run RepeatCount times in the trace rooted at Endpoint.
// Statement is always the normalized fingerprint (never a raw literal, §6).
type NPlusOneFinding struct {
	Statement string `json:"statement"`
	DBSystem  string `json:"dbSystem"`
	Table     string `json:"table,omitempty"`
	// RepeatCount is how many times this normalized statement ran in the trace.
	RepeatCount int `json:"repeatCount"`
	// Endpoint is the root span / route the request entered through.
	Endpoint string `json:"endpoint"`
	// TotalDBSpans is the number of DB spans observed in the trace (a sample,
	// capped at nplusoneSpansPerSet).
	TotalDBSpans int `json:"totalDbSpans"`
	// TraceID links to the offending trace.
	TraceID string `json:"traceId"`
	// Remediation is the per-system hint (JOIN/batch, MGET/pipeline, $in, …).
	Remediation string `json:"remediation"`
}

// NPlusOneResponse is the /database/nplusone payload.
type NPlusOneResponse struct {
	// Mode is "traceql" when Tempo answered, else "unavailable".
	Mode     string            `json:"mode"`
	Findings []NPlusOneFinding `json:"findings"`
	// ScannedTraces is the number of candidate traces the scan inspected.
	ScannedTraces int `json:"scannedTraces"`
	// Truncated is true when the candidate-trace limit was hit.
	Truncated bool `json:"truncated"`
	// WindowSeconds is the effective (possibly clamped) window queried.
	WindowSeconds int `json:"windowSeconds"`
	// Threshold is the per-trace repeat count that qualifies a finding.
	Threshold int    `json:"threshold"`
	Note      string `json:"note,omitempty"`
}

// handleDatabaseNPlusOne runs an on-demand, bounded Tempo scan for N+1 query
// patterns in this service's traces.
// GET /services/{namespace}/{service}/database/nplusone?from=&to=&tracesUid=
func (a *App) handleDatabaseNPlusOne(w http.ResponseWriter, req *http.Request) {
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
	from = clampWindow(from, to, nplusoneWindowCap)

	tracesUID := sanitizeDatasourceUID(req.URL.Query().Get("tracesUid"))
	// Confused-deputy hardening: only the configured traces datasource(s) may be
	// proxied with the SA token (mirrors handleDatabaseQueries).
	if tracesUID == "" || !a.settings.TracesDataSource.Allows(tracesUID) {
		writeJSON(w, NPlusOneResponse{Mode: "unavailable", Findings: []NPlusOneFinding{}, Threshold: nplusoneRepeatThreshold, Note: "traces datasource not configured"})
		return
	}

	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("dbnplusone", orgID, roundedUnix(from), roundedUnix(to), namespace, service, tracesUID)
	headers := req.Header
	a.writeCached(w, ck, "scanning for N+1 query patterns failed", func() (any, error) {
		return a.scanNPlusOne(ctx, headers, tracesUID, namespace, service, from, to), nil
	})
}

// scanNPlusOne runs the bounded candidate-trace search, groups each trace's DB
// spans by normalized statement, and returns the repeated-query offenders.
// Degrades to an "unavailable" response (never hangs) when Tempo errors/times out.
func (a *App) scanNPlusOne(ctx context.Context, headers http.Header, tracesUID, namespace, service string, from, to time.Time) NPlusOneResponse {
	logger := log.DefaultLogger.With("handler", "database-nplusone")
	windowSec := int(to.Sub(from).Seconds())

	traces, truncated, err := a.searchNPlusOneTraces(ctx, headers, tracesUID, namespace, service, from, to)
	if err != nil {
		logger.Warn("Tempo N+1 candidate search failed", "service", sanitizeLogValue(service), "error", err)
		return NPlusOneResponse{
			Mode: "unavailable", Findings: []NPlusOneFinding{}, WindowSeconds: windowSec,
			Threshold: nplusoneRepeatThreshold,
			Note:      "trace search unavailable (Tempo may be busy) — try a narrower range",
		}
	}

	findings := detectNPlusOne(traces, nplusoneRepeatThreshold, nplusoneMaxFindings)
	return NPlusOneResponse{
		Mode:          "traceql",
		Findings:      findings,
		ScannedTraces: len(traces),
		Truncated:     truncated,
		WindowSeconds: windowSec,
		Threshold:     nplusoneRepeatThreshold,
	}
}

// nplusTrace is one candidate trace: its endpoint (root span) and DB spans.
type nplusTrace struct {
	traceID  string
	endpoint string
	spans    []dbSpan
}

// detectNPlusOne groups each trace's DB spans by (db.system, normalized
// statement) and emits a finding for every group repeated at least `threshold`
// times in that one trace. Findings are ordered by repeat count desc (the worst
// offenders first) and capped at `limit`.
//nolint:unparam // threshold is a tunable N+1 sensitivity knob (§9); kept a param so the grouping logic is exercised at other thresholds in tests.
func detectNPlusOne(traces []nplusTrace, threshold, limit int) []NPlusOneFinding {
	findings := make([]NPlusOneFinding, 0)
	for _, tr := range traces {
		type group struct {
			system string
			table  string
			norm   string
			count  int
		}
		groups := make(map[string]*group)
		for _, s := range tr.spans {
			norm := normalizeStatement(s.system, s.statement)
			if norm == "" {
				continue
			}
			key := s.system + "\x00" + norm
			g := groups[key]
			if g == nil {
				g = &group{system: s.system, norm: norm}
				groups[key] = g
			}
			if g.table == "" && s.table != "" {
				g.table = s.table
			}
			g.count++
		}
		totalDBSpans := len(tr.spans)
		for _, g := range groups {
			if g.count < threshold {
				continue
			}
			findings = append(findings, NPlusOneFinding{
				Statement:    g.norm,
				DBSystem:     g.system,
				Table:        g.table,
				RepeatCount:  g.count,
				Endpoint:     tr.endpoint,
				TotalDBSpans: totalDBSpans,
				TraceID:      tr.traceID,
				Remediation:  remediationHint(g.system),
			})
		}
	}

	// Worst offenders first; stable tiebreak so output is deterministic.
	sort.Slice(findings, func(i, j int) bool {
		if findings[i].RepeatCount != findings[j].RepeatCount {
			return findings[i].RepeatCount > findings[j].RepeatCount
		}
		if findings[i].Endpoint != findings[j].Endpoint {
			return findings[i].Endpoint < findings[j].Endpoint
		}
		return findings[i].Statement < findings[j].Statement
	})
	if len(findings) > limit {
		findings = findings[:limit]
	}
	return findings
}

// remediationHint returns the per-system fix for a repeated-query pattern (§5).
// Unknown systems fall through to the SQL advice (the common case).
func remediationHint(system string) string {
	switch classifyDBFamily(system) {
	case familyKeyValue:
		return "Batch the repeated lookups into one round-trip — use MGET (or a pipeline / MULTI) instead of a GET per key."
	case familyDocument:
		if isOpenSearchLike(system) {
			return "Collapse the repeated searches into a single bulk or multi-search (_msearch) request."
		}
		return "Fetch the documents in one query — use $in on the id field, or an aggregation, instead of a find() per document."
	default:
		// postgresql / oracle / db2 / h2 / other_sql.
		if isOracle(system) {
			return "Replace the per-row queries with a JOIN or a batch fetch (IN (…)); if it must stay, check the plan/index for the repeated statement."
		}
		return "Replace the per-row queries with a JOIN, a batch fetch, or a single IN (…) clause instead of one query per row."
	}
}

func isOpenSearchLike(system string) bool {
	switch system {
	case "opensearch", "elasticsearch":
		return true
	}
	return false
}

func isOracle(system string) bool {
	return system == "oracle"
}

// searchNPlusOneTraces runs one bounded TraceQL scan for candidate traces —
// those with more DB client spans than the repeat floor — pulling each span's
// db.statement/system/table via select(), grouped per trace. Returns the
// candidate traces and whether the trace limit was hit.
//
// TraceQL: { <svc> = "…" [&& <ns> = "…"] && span.db.system != "" }
//          | select(span.db.statement, span.db.system, span.db.sql.table)
//          | count() > <repeat-1>
func (a *App) searchNPlusOneTraces(ctx context.Context, headers http.Header, tracesUID, namespace, service string, from, to time.Time) ([]nplusTrace, bool, error) {
	base := a.proxyURL(tracesUID)
	if base == "" {
		return nil, false, fmt.Errorf("traces datasource not configured")
	}

	svc := a.otelCfg.TraceQL.ServiceName
	selector := fmt.Sprintf(`{ %s = %q && span.db.system != "" }`, svc, service)
	if namespace != "" {
		selector = fmt.Sprintf(`{ %s = %q && %s = %q && span.db.system != "" }`,
			svc, service, a.otelCfg.TraceQL.ServiceNamespace, namespace)
	}
	// count() > (repeat-1) is the candidate floor: a trace cannot repeat a single
	// statement `repeat` times unless it holds at least that many DB spans. The
	// exact per-statement duplicate count is confirmed in detectNPlusOne.
	query := selector +
		` | select(span.db.statement, span.db.system, span.db.sql.table)` +
		fmt.Sprintf(` | count() > %d`, nplusoneRepeatThreshold-1)

	q := url.Values{
		"q":     {query},
		"limit": {strconv.Itoa(nplusoneTraceLimit)},
		"spss":  {strconv.Itoa(nplusoneSpansPerSet)},
		"start": {strconv.FormatInt(from.Unix(), 10)},
		"end":   {strconv.FormatInt(to.Unix(), 10)},
	}
	reqURL := base + "/api/search?" + q.Encode()

	ctx, cancel := context.WithTimeout(ctx, nplusoneTimeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, false, err
	}
	applyProxyAuth(httpReq, headers, a.resolveServiceToken(ctx))

	client := &http.Client{Timeout: nplusoneTimeout}
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
	traces := parseNPlusOneResponse(body)
	return traces, len(traces) >= nplusoneTraceLimit, nil
}

// parseNPlusOneResponse groups the search response by trace (unlike the
// top-queries parser, which flattens), keeping each trace's endpoint (root span)
// so detectNPlusOne can attribute the N+1 to a request. Spans are deduped by
// spanID (Tempo echoes them under both spanSet and spanSets).
func parseNPlusOneResponse(body []byte) []nplusTrace {
	var parsed tempoSearchResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil
	}
	var out []nplusTrace
	for _, t := range parsed.Traces {
		sets := t.SpanSets
		if len(sets) == 0 && t.SpanSet != nil {
			sets = []tempoSpanSet{*t.SpanSet}
		}
		tr := nplusTrace{traceID: t.TraceID, endpoint: rootEndpointName(t.RootServiceName, t.RootTraceName)}
		seen := make(map[string]struct{})
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
				tr.spans = append(tr.spans, span)
			}
		}
		if len(tr.spans) == 0 {
			continue
		}
		out = append(out, tr)
	}
	return out
}

// rootEndpointName labels the request a trace belongs to. Tempo's root span name
// (e.g. "GET /oppgaveliste.jsf") is the endpoint; the root service name is only
// prefixed when it differs from this service (a downstream-owned root). Falls
// back gracefully when Tempo omitted the root metadata.
func rootEndpointName(rootService, rootTrace string) string {
	if rootTrace == "" {
		if rootService != "" {
			return rootService
		}
		return "unknown request"
	}
	return rootTrace
}
