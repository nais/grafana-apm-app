package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/fingerprint"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// Server issues have no Alloy hash — their identity is the one-way fingerprint
// v1:<hex>. The drawer therefore cannot self-serve occurrences from a Loki hash
// query the way browser issues do; instead this endpoint re-scans the same
// three server-log shapes queryServerExceptionGroups aggregates over, recomputes
// the fingerprint per line, and returns the lines whose fingerprint matches the
// requested one (#84 Phase 1).

// semconvStacktraceLabel is the OTLP/semconv exception stack-trace attribute,
// carried as structured metadata (dots normalized to underscores) alongside
// exception_type / exception_message.
const semconvStacktraceLabel = "exception_stacktrace"

// detectedLevelLabel is Loki's log-level detection structured metadata, used as
// the level for shapes that carry no explicit level field.
const detectedLevelLabel = "detected_level"

// serverVersionLabel is a best-effort app-version source for shape (a): OTLP
// resource attribute service.version becomes structured metadata service_version
// when present. It is absent on most streams, so version stays blank there —
// full per-shape version attribution is deferred (#84 defers b/c; there is no
// configured backend-log version label to survey yet).
const serverVersionLabel = "service_version"

// traceIDLabel / spanIDLabel are the OTLP trace-correlation identifiers. On the
// Loki OTLP endpoint they arrive as structured metadata (trace_id / span_id);
// json and plaintext apps that emit correlation IDs commonly log the same field
// names, so they are read best-effort across all three shapes. A populated
// trace_id is what lets the drawer deep-link a thin log line to its full trace —
// the spans / http / db / timing context the log line itself lacks.
const (
	traceIDLabel = "trace_id"
	spanIDLabel  = "span_id"
)

// jsonBodyExclude are JSON-body fields already modeled on IssueOccurrence (or
// pure noise) and therefore kept out of the free-form Attributes bag. Trace/span
// aliases are excluded here because they are surfaced as TraceID/SpanID.
var jsonBodyExclude = map[string]bool{
	jsonMessageLabel: true, jsonMsgLabel: true, "level": true,
	"stack_trace": true, "stack": true, "stacktrace": true, "exception": true,
	"trace_id": true, "traceId": true, "traceID": true, "traceid": true,
	"span_id": true, "spanId": true, "spanID": true, "spanid": true,
	"timestamp": true, "time": true, "ts": true, "@timestamp": true,
}

// occurrenceCap bounds the per-shape line scan. Matches the drawer's browser
// side (100 lines aggregated for impact); enough to characterize an issue
// without pulling unbounded log volume.
const occurrenceCap = 100

// minAnchorLen is the minimum length (in runes) for a literal anchor derived
// from a group title. Shorter fragments ("at ", "in") match almost every
// line and would only cost Loki regex work without narrowing anything.
const minAnchorLen = 4

// anchorPlaceholders matches the dynamic-token placeholders fingerprint
// normalization substitutes into group titles (fingerprint.Normalize). The
// literal text BETWEEN placeholders is what raw log lines still contain.
var anchorPlaceholders = regexp.MustCompile(`<(?:url|email|uuid|ts|ip|hex|num)>`)

// literalAnchor extracts the longest placeholder-free run from a
// fingerprint-normalized message template — a substring every raw occurrence
// of the issue must still contain. Returns "" when no usable run exists
// (e.g. a title that is a single placeholder), in which case the scan runs
// unanchored exactly as before.
func literalAnchor(template string) string {
	best := ""
	for _, seg := range anchorPlaceholders.Split(template, -1) {
		seg = strings.TrimSpace(seg)
		if len([]rune(seg)) >= minAnchorLen && len(seg) > len(best) {
			best = seg
		}
	}
	return best
}

// messageTemplate strips the "Type: " prefix buildTitle prepends, so anchors
// come from the message part only — raw lines carry the type in a separate
// field (or not at all), never concatenated into the message.
func messageTemplate(title, exType string) string {
	if exType != "" {
		if rest, ok := strings.CutPrefix(title, exType+": "); ok {
			return rest
		}
	}
	return title
}

// IssueOccurrence is one matched server-log line for an issue, extracted per
// log shape. It mirrors the fields the ExceptionDrawer renders for a browser
// occurrence, translated to the server world (pod instead of session).
type IssueOccurrence struct {
	TimeMs     int64  `json:"timeMs"`
	Pod        string `json:"pod,omitempty"`
	Level      string `json:"level,omitempty"`
	Message    string `json:"message"`
	Stacktrace string `json:"stacktrace,omitempty"`
	Version    string `json:"version,omitempty"`
	Type       string `json:"type,omitempty"`
	// TraceID / SpanID correlate this line to its distributed trace when the app
	// logs them (always for OTLP logs; best-effort for json/plaintext). The
	// drawer uses TraceID to deep-link the exact trace.
	TraceID string `json:"traceId,omitempty"`
	SpanID  string `json:"spanId,omitempty"`
	// Attributes are the remaining structured-metadata / body fields the line
	// carries (k8s container/node, logger, http.route/status, app-added fields)
	// minus everything already modeled above. This is the extra context that
	// makes thin shape (b)/(c) occurrences useful. Nil when the line adds nothing.
	Attributes map[string]string `json:"attributes,omitempty"`
}

// IssueOccurrenceStats is the aggregate blast radius across the returned
// occurrences, folded Go-side to match the browser AggregatedStats shape
// (sessions ↔ pods).
type IssueOccurrenceStats struct {
	Total       int      `json:"total"`
	Pods        int      `json:"pods"`
	FirstSeenMs int64    `json:"firstSeenMs,omitempty"`
	LastSeenMs  int64    `json:"lastSeenMs,omitempty"`
	Versions    []string `json:"versions"`
}

// emptyOccurrenceStats is the zero-value stats block with a non-nil versions
// slice, so the JSON payload always carries versions as [] (the OpenAPI array
// schema) rather than null in the empty/unavailable early-return paths.
func emptyOccurrenceStats() IssueOccurrenceStats {
	return IssueOccurrenceStats{Versions: []string{}}
}

// IssueOccurrencesResponse is the /issues/occurrences payload: the raw server
// occurrences for one fingerprint plus their aggregate stats.
type IssueOccurrencesResponse struct {
	Fingerprint string `json:"fingerprint"`
	// Shape is the server-log shape the matched lines came from: "otlp"
	// (semconv structured metadata), "json" (parsed body), or "plaintext".
	Shape       string               `json:"shape,omitempty"`
	Occurrences []IssueOccurrence    `json:"occurrences"`
	Stats       IssueOccurrenceStats `json:"stats"`
	// Truncated is set when a shape scan hit occurrenceCap — more lines exist.
	Truncated bool `json:"truncated,omitempty"`
	// Unavailable is set when Loki is unconfigured for the environment.
	Unavailable bool `json:"unavailable,omitempty"`
}

// handleIssueOccurrences returns the server-log occurrences for one issue
// fingerprint (#84 Phase 1), the data path behind the server-issue drawer.
// GET /services/{namespace}/{service}/issues/occurrences?fingerprint=<fp>&from=&to=&environment=
func (a *App) handleIssueOccurrences(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	namespace, service := parseServiceRef(req)
	env := parseEnvironment(req)
	if !requireServiceParam(w, service) {
		return
	}
	from, to := parseTimeRange(req)
	// The colon in v1:<hex> is in the label-safe set, so the fingerprint passes
	// the sanitizer unchanged; a malformed value sanitizes to "" and matches
	// nothing (empty occurrence list), never interpolated anywhere unsafe.
	fp := queries.MustSanitizeLabel(req.URL.Query().Get("fingerprint"))
	// Optional narrowing hints from the issue row the drawer was opened from
	// (#84 follow-up): the group title (fingerprint-normalized template) and
	// exception type. Free text — never interpolated into LogQL directly, only
	// via strconv.Quote'd literals (see occurrencePipelines). Absent on old
	// clients; the scan then runs unanchored as before.
	title := req.URL.Query().Get("title")
	exType := req.URL.Query().Get("type")

	lokiUID := a.settings.LogsDataSource.Resolve(env).UID
	if lokiUID == "" {
		// Explicit zero stats with a non-nil versions slice so the payload
		// serializes versions as [] (matching the OpenAPI array schema), not null.
		writeJSON(w, IssueOccurrencesResponse{
			Fingerprint: fp,
			Occurrences: []IssueOccurrence{},
			Stats:       emptyOccurrenceStats(),
			Unavailable: true,
		})
		return
	}
	if fp == "" {
		writeJSON(w, IssueOccurrencesResponse{Fingerprint: fp, Occurrences: []IssueOccurrence{}, Stats: emptyOccurrenceStats()})
		return
	}

	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("issue-occurrences", orgID, namespace, service, env, fp, title, exType, roundedUnix(from), roundedUnix(to))
	dsClient := queries.NewDsQueryClient(a.grafanaURL, a.resolveServiceToken(ctx)).WithAuthHeaders(req.Header)
	a.writeCached(w, ck, "querying issue occurrences failed", func() (any, error) {
		return a.queryIssueOccurrences(ctx, dsClient, lokiUID, service, env, fp, title, exType, from, to), nil
	})
}

// queryIssueOccurrences re-scans the three server-log shapes and returns the
// lines whose recomputed fingerprint equals wantFP.
//
// The list side counts issues with metric queries that see EVERY line in
// range, but this side fetches raw lines capped at occurrenceCap per shape —
// on a chatty service the cap sample can easily contain zero lines of the
// requested issue, which surfaced as "no occurrences found in range" for an
// issue the list had just shown. When the drawer supplies the group title /
// type, the scan is therefore anchored: a literal fragment of the normalized
// title narrows the Loki queries to lines that can actually match, making the
// cap budget count only relevant lines. The Go-side fingerprint check stays
// authoritative; if an anchored scan matches nothing (whitespace collapse or
// JSON escaping can defeat a literal anchor), it falls back to the unanchored
// scan, so recall is never worse than before.
func (a *App) queryIssueOccurrences(ctx context.Context, ds *queries.DsQueryClient, lokiUID, service, env, wantFP, title, exType string, from, to time.Time) IssueOccurrencesResponse {
	sel := a.serverLogSelector(service, env)
	anchor := literalAnchor(messageTemplate(title, exType))
	resp := a.scanOccurrences(ctx, ds, lokiUID, sel, wantFP, exType, anchor, from, to)
	if len(resp.Occurrences) == 0 && (anchor != "" || exType != "") {
		resp = a.scanOccurrences(ctx, ds, lokiUID, sel, wantFP, "", "", from, to)
	}
	return resp
}

// scanOccurrences runs one pass over the three server-log shapes, optionally
// narrowed by an exception type and a literal message anchor, and folds the
// fingerprint-matching lines into the response. It reuses the exact shape
// selectors/pipelines from queryServerExceptionGroups — with LogQueryWithLabels
// in place of the metric count queries — so a line lands in the same shape (and
// therefore the same fingerprint) it was originally aggregated under.
func (a *App) scanOccurrences(ctx context.Context, ds *queries.DsQueryClient, lokiUID, sel, wantFP, exType, anchor string, from, to time.Time) IssueOccurrencesResponse {
	logger := log.DefaultLogger.With("handler", "issue-occurrences")

	// The same three pipelines queryServerExceptionGroups counts over, minus
	// the count_over_time wrapper (raw log queries here). exception_type="" on
	// (b)/(c) keeps a line answerable by exactly one shape, so recomputed
	// fingerprints never cross shapes.
	//
	// Anchoring (all narrowing values go through strconv.Quote — Loki string
	// literals share Go escaping — so client-supplied text can never break out
	// of the query): shape (a) carries the message in structured metadata, so
	// it narrows via label filters; shapes (b)/(c) carry it in the line body,
	// so they narrow via a substring line filter right after the selector
	// (cheapest position). (?s) lets the regex cross newlines in multi-line
	// messages.
	semconvPipeline := sel + " | " + semconvTypeLabel + ` != ""`
	if exType != "" {
		semconvPipeline += " | " + semconvTypeLabel + "=" + strconv.Quote(exType)
	}
	if anchor != "" {
		semconvPipeline += " | " + semconvMessageLabel + "=~" + strconv.Quote("(?s).*"+regexp.QuoteMeta(anchor)+".*")
	}
	lineAnchor := ""
	if anchor != "" {
		lineAnchor = " |= " + strconv.Quote(anchor)
	}
	jsonPipeline := sel + lineAnchor + " | " + semconvTypeLabel + `="" | json | level=~"` + errorLevelRe + `" or ` +
		detectedLevelLabel + `=~"` + errorLevelRe + `" | ` + jsonMessageLabel + ` != "" or ` + jsonMsgLabel + ` != ""`
	plainPipeline := sel + lineAnchor + ` | ` + detectedLevelLabel + `=~"` + errorLevelRe + `" | ` + semconvTypeLabel +
		`="" | json | drop __error__, __error_details__ | ` + jsonMessageLabel + `="" | ` + jsonMsgLabel + `=""`

	var (
		wg                            sync.WaitGroup
		semLines, jsonLines, plaLines []queries.LogEntryWithLabels
		semErr, jsonErr, plaErr       error
	)
	wg.Add(3)
	go func() {
		defer wg.Done()
		semLines, semErr = ds.LogQueryWithLabels(ctx, lokiUID, semconvPipeline, from, to, occurrenceCap)
	}()
	go func() {
		defer wg.Done()
		jsonLines, jsonErr = ds.LogQueryWithLabels(ctx, lokiUID, jsonPipeline, from, to, occurrenceCap)
	}()
	go func() {
		defer wg.Done()
		plaLines, plaErr = ds.LogQueryWithLabels(ctx, lokiUID, plainPipeline, from, to, occurrenceCap)
	}()
	wg.Wait()

	if semErr != nil {
		logger.Warn("Occurrence semconv query failed", "error", semErr)
	}
	if jsonErr != nil {
		logger.Warn("Occurrence json query failed", "error", jsonErr)
	}
	if plaErr != nil {
		logger.Warn("Occurrence plain-text query failed", "error", plaErr)
	}

	resp := IssueOccurrencesResponse{Fingerprint: wantFP, Occurrences: []IssueOccurrence{}}
	shape := ""
	setShape := func(s string) {
		if shape == "" {
			shape = s
		}
	}

	// Fields already modeled on IssueOccurrence — plus stream-identity labels
	// implied by the drawer context (service / env / kind) — are excluded from
	// the free-form Attributes bag so it carries only the extra context the line
	// adds (k8s attrs, logger, http fields, app-added structured fields).
	attrExclude := map[string]bool{
		podLabel:                       true,
		detectedLevelLabel:             true,
		semconvTypeLabel:               true,
		semconvMessageLabel:            true,
		semconvStacktraceLabel:         true,
		serverVersionLabel:             true,
		traceIDLabel:                   true,
		spanIDLabel:                    true,
		jsonMessageLabel:               true,
		jsonMsgLabel:                   true,
		"level":                        true,
		a.otelCfg.Labels.ServiceName:   true,
		a.otelCfg.Labels.DeploymentEnv: true,
		a.otelCfg.FaroLoki.Kind:        true,
	}

	// Shape (a) — OTLP/semconv structured metadata.
	for _, l := range semExtract(semLines, wantFP, attrExclude) {
		resp.Occurrences = append(resp.Occurrences, l)
		setShape("otlp")
	}
	// Shape (b) — JSON body.
	for _, l := range jsonExtract(jsonLines, wantFP, attrExclude) {
		resp.Occurrences = append(resp.Occurrences, l)
		setShape("json")
	}
	// Shape (c) — unstructured plain text.
	for _, l := range plainExtract(plaLines, wantFP, attrExclude) {
		resp.Occurrences = append(resp.Occurrences, l)
		setShape("plaintext")
	}
	resp.Shape = shape
	resp.Truncated = len(semLines) >= occurrenceCap || len(jsonLines) >= occurrenceCap || len(plaLines) >= occurrenceCap

	// Newest first — the drawer defaults to the most recent occurrence.
	sort.SliceStable(resp.Occurrences, func(i, j int) bool {
		return resp.Occurrences[i].TimeMs > resp.Occurrences[j].TimeMs
	})
	resp.Stats = foldOccurrenceStats(resp.Occurrences)
	return resp
}

// semExtract keeps the semconv lines whose (type, message) fingerprint matches,
// reading stacktrace / pod / level / version / trace correlation and the
// remaining structured-metadata fields from the label set.
func semExtract(lines []queries.LogEntryWithLabels, wantFP string, attrExclude map[string]bool) []IssueOccurrence {
	out := make([]IssueOccurrence, 0, len(lines))
	for _, l := range lines {
		exType := l.Labels[semconvTypeLabel]
		msg := l.Labels[semconvMessageLabel]
		if msg == "" && exType == "" {
			continue
		}
		if fingerprint.Compute(fingerprint.Event{Type: exType, Value: msg}).Value != wantFP {
			continue
		}
		out = append(out, IssueOccurrence{
			TimeMs:     l.TimeMs,
			Pod:        l.Labels[podLabel],
			Level:      l.Labels[detectedLevelLabel],
			Message:    msg,
			Stacktrace: l.Labels[semconvStacktraceLabel],
			Version:    l.Labels[serverVersionLabel],
			Type:       exType,
			TraceID:    l.Labels[traceIDLabel],
			SpanID:     l.Labels[spanIDLabel],
			Attributes: occurrenceAttributes(l.Labels, attrExclude),
		})
	}
	return out
}

// jsonExtract parses each JSON body for its message (message|msg) and optional
// stack trace (stack_trace|stack), matching on the message-only fingerprint —
// the same key queryServerExceptionGroups grouped shape (b) under.
func jsonExtract(lines []queries.LogEntryWithLabels, wantFP string, attrExclude map[string]bool) []IssueOccurrence {
	out := make([]IssueOccurrence, 0, len(lines))
	for _, l := range lines {
		body := map[string]json.RawMessage{}
		if err := json.Unmarshal([]byte(l.Line), &body); err != nil {
			continue
		}
		msg := jsonStr(body, jsonMessageLabel)
		if msg == "" {
			msg = jsonStr(body, jsonMsgLabel)
		}
		if msg == "" {
			continue
		}
		if fingerprint.Compute(fingerprint.Event{Value: msg}).Value != wantFP {
			continue
		}
		stack := jsonStr(body, "stack_trace")
		if stack == "" {
			stack = jsonStr(body, "stack")
		}
		level := jsonStr(body, "level")
		if level == "" {
			level = l.Labels[detectedLevelLabel]
		}
		// Trace correlation: prefer structured metadata, fall back to a body
		// field (many apps log trace_id / traceId inline in the JSON).
		traceID := l.Labels[traceIDLabel]
		if traceID == "" {
			traceID = jsonFirstStr(body, "trace_id", "traceId", "traceID", "traceid")
		}
		spanID := l.Labels[spanIDLabel]
		if spanID == "" {
			spanID = jsonFirstStr(body, "span_id", "spanId", "spanID", "spanid")
		}
		// Context = structured-metadata fields (k8s attrs, logger) merged with the
		// app's own scalar JSON fields (http.route/status, business context).
		attrs := occurrenceAttributes(l.Labels, attrExclude)
		attrs = mergeJSONAttributes(attrs, body)
		out = append(out, IssueOccurrence{
			TimeMs:     l.TimeMs,
			Pod:        l.Labels[podLabel],
			Level:      level,
			Message:    msg,
			Stacktrace: stack,
			TraceID:    traceID,
			SpanID:     spanID,
			Attributes: attrs,
		})
	}
	return out
}

// plainExtract keeps unstructured lines whose message-only fingerprint matches,
// dropping the framework bootstrap noise the grouping path also filters out.
func plainExtract(lines []queries.LogEntryWithLabels, wantFP string, attrExclude map[string]bool) []IssueOccurrence {
	out := make([]IssueOccurrence, 0, len(lines))
	for _, l := range lines {
		msg := trimSpaceLimited(l.Line)
		if msg == "" || isBootstrapNoiseLine(msg) {
			continue
		}
		if fingerprint.Compute(fingerprint.Event{Value: msg}).Value != wantFP {
			continue
		}
		out = append(out, IssueOccurrence{
			TimeMs:     l.TimeMs,
			Pod:        l.Labels[podLabel],
			Level:      l.Labels[detectedLevelLabel],
			Message:    msg,
			TraceID:    l.Labels[traceIDLabel],
			SpanID:     l.Labels[spanIDLabel],
			Attributes: occurrenceAttributes(l.Labels, attrExclude),
		})
	}
	return out
}

// occurrenceAttributes folds a line's label set into the free-form Attributes
// bag, dropping empty values, the modeled/identity keys in exclude, and Loki's
// internal __*__ labels. Returns nil (not an empty map) when nothing remains so
// the JSON omits the field and the drawer renders no empty section.
func occurrenceAttributes(labels map[string]string, exclude map[string]bool) map[string]string {
	if len(labels) == 0 {
		return nil
	}
	out := make(map[string]string, len(labels))
	for k, v := range labels {
		if v == "" || exclude[k] || strings.HasPrefix(k, "__") {
			continue
		}
		out[k] = v
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// mergeJSONAttributes adds the app's own scalar JSON body fields (http.route,
// status, logger, business context) into attrs, skipping fields already modeled
// (jsonBodyExclude) and non-scalar values (nested objects/arrays are too noisy
// for the context list). attrs may be nil; a map is allocated only if something
// is added.
func mergeJSONAttributes(attrs map[string]string, body map[string]json.RawMessage) map[string]string {
	for k, raw := range body {
		if jsonBodyExclude[k] {
			continue
		}
		v, ok := jsonScalarStr(raw)
		if !ok {
			continue
		}
		if attrs == nil {
			attrs = make(map[string]string)
		}
		attrs[k] = v
	}
	return attrs
}

// jsonFirstStr returns the first non-empty string value among the given keys.
func jsonFirstStr(body map[string]json.RawMessage, keys ...string) string {
	for _, k := range keys {
		if v := jsonStr(body, k); v != "" {
			return v
		}
	}
	return ""
}

// jsonScalarStr renders a scalar JSON value (string, number, bool) as a string.
// Objects, arrays, null, and empty values yield ok=false so they are skipped.
func jsonScalarStr(raw json.RawMessage) (string, bool) {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return "", false
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		if str == "" {
			return "", false
		}
		return str, true
	}
	// Non-string scalar (number/bool): keep the raw token. Objects/arrays and
	// malformed strings are dropped.
	if s[0] == '{' || s[0] == '[' || s[0] == '"' {
		return "", false
	}
	return s, true
}

// jsonStr reads a string-valued JSON field, tolerating that the value may be a
// bare string or (defensively) any scalar re-quoted. Missing or non-string
// values yield "".
func jsonStr(body map[string]json.RawMessage, key string) string {
	raw, ok := body[key]
	if !ok {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return ""
}

// foldOccurrenceStats aggregates the blast radius: total, distinct pods,
// first/last seen, and distinct versions.
func foldOccurrenceStats(occ []IssueOccurrence) IssueOccurrenceStats {
	stats := IssueOccurrenceStats{Total: len(occ), Versions: []string{}}
	pods := map[string]bool{}
	versions := map[string]bool{}
	for _, o := range occ {
		if o.Pod != "" {
			pods[o.Pod] = true
		}
		if o.Version != "" && !versions[o.Version] {
			versions[o.Version] = true
			stats.Versions = append(stats.Versions, o.Version)
		}
		if o.TimeMs > 0 {
			if stats.FirstSeenMs == 0 || o.TimeMs < stats.FirstSeenMs {
				stats.FirstSeenMs = o.TimeMs
			}
			if o.TimeMs > stats.LastSeenMs {
				stats.LastSeenMs = o.TimeMs
			}
		}
	}
	stats.Pods = len(pods)
	sort.Strings(stats.Versions)
	return stats
}
