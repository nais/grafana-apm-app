package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
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

// occurrenceCap bounds the per-shape line scan. Matches the drawer's browser
// side (100 lines aggregated for impact); enough to characterize an issue
// without pulling unbounded log volume.
const occurrenceCap = 100

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

// IssueOccurrencesResponse is the /issues/occurrences payload: the raw server
// occurrences for one fingerprint plus their aggregate stats.
type IssueOccurrencesResponse struct {
	Fingerprint string               `json:"fingerprint"`
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

	lokiUID := a.settings.LogsDataSource.Resolve(env).UID
	if lokiUID == "" {
		writeJSON(w, IssueOccurrencesResponse{Fingerprint: fp, Occurrences: []IssueOccurrence{}, Unavailable: true})
		return
	}
	if fp == "" {
		writeJSON(w, IssueOccurrencesResponse{Fingerprint: fp, Occurrences: []IssueOccurrence{}, Stats: IssueOccurrenceStats{Versions: []string{}}})
		return
	}

	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("issue-occurrences", orgID, namespace, service, env, fp, roundedUnix(from), roundedUnix(to))
	dsClient := queries.NewDsQueryClient(a.grafanaURL, a.resolveServiceToken(ctx)).WithAuthHeaders(req.Header)
	a.writeCached(w, ck, "querying issue occurrences failed", func() (any, error) {
		return a.queryIssueOccurrences(ctx, dsClient, lokiUID, service, env, fp, from, to), nil
	})
}

// queryIssueOccurrences re-scans the three server-log shapes and returns the
// lines whose recomputed fingerprint equals wantFP. It reuses the exact shape
// selectors/pipelines from queryServerExceptionGroups — with LogQueryWithLabels
// in place of the metric count queries — so a line lands in the same shape (and
// therefore the same fingerprint) it was originally aggregated under.
func (a *App) queryIssueOccurrences(ctx context.Context, ds *queries.DsQueryClient, lokiUID, service, env, wantFP string, from, to time.Time) IssueOccurrencesResponse {
	logger := log.DefaultLogger.With("handler", "issue-occurrences")
	sel := a.serverLogSelector(service, env)

	// The same three pipelines queryServerExceptionGroups counts over, minus
	// the count_over_time wrapper (raw log queries here). exception_type="" on
	// (b)/(c) keeps a line answerable by exactly one shape, so recomputed
	// fingerprints never cross shapes.
	semconvPipeline := sel + " | " + semconvTypeLabel + ` != ""`
	jsonPipeline := sel + " | " + semconvTypeLabel + `="" | json | level=~"` + errorLevelRe + `" or ` +
		detectedLevelLabel + `=~"` + errorLevelRe + `" | ` + jsonMessageLabel + ` != "" or ` + jsonMsgLabel + ` != ""`
	plainPipeline := sel + ` | ` + detectedLevelLabel + `=~"` + errorLevelRe + `" | ` + semconvTypeLabel +
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

	// Shape (a) — OTLP/semconv structured metadata.
	for _, l := range semExtract(semLines, wantFP) {
		resp.Occurrences = append(resp.Occurrences, l)
		setShape("otlp")
	}
	// Shape (b) — JSON body.
	for _, l := range jsonExtract(jsonLines, wantFP) {
		resp.Occurrences = append(resp.Occurrences, l)
		setShape("json")
	}
	// Shape (c) — unstructured plain text.
	for _, l := range plainExtract(plaLines, wantFP) {
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
// reading stacktrace / pod / level / version from structured metadata.
func semExtract(lines []queries.LogEntryWithLabels, wantFP string) []IssueOccurrence {
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
		})
	}
	return out
}

// jsonExtract parses each JSON body for its message (message|msg) and optional
// stack trace (stack_trace|stack), matching on the message-only fingerprint —
// the same key queryServerExceptionGroups grouped shape (b) under.
func jsonExtract(lines []queries.LogEntryWithLabels, wantFP string) []IssueOccurrence {
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
		out = append(out, IssueOccurrence{
			TimeMs:     l.TimeMs,
			Pod:        l.Labels[podLabel],
			Level:      level,
			Message:    msg,
			Stacktrace: stack,
		})
	}
	return out
}

// plainExtract keeps unstructured lines whose message-only fingerprint matches,
// dropping the framework bootstrap noise the grouping path also filters out.
func plainExtract(lines []queries.LogEntryWithLabels, wantFP string) []IssueOccurrence {
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
			TimeMs:  l.TimeMs,
			Pod:     l.Labels[podLabel],
			Level:   l.Labels[detectedLevelLabel],
			Message: msg,
		})
	}
	return out
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
