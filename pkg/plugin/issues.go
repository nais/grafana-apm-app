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

	"github.com/nais/grafana-otel-plugin/pkg/plugin/fingerprint"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// Issue source tags (#63 Phase 1). "traces" arrives with Phase 2.
const (
	issueSourceBrowser = "browser"
	issueSourceServer  = "server"
)

// podLabel is the stream label carrying the pod name on backend log streams.
// Mirrors LogsTab.tsx, which filters backend logs on k8s_pod_name (only
// present on backend streams, never on Faro streams).
const podLabel = "k8s_pod_name"

// Shape (a) — OTLP/semconv exception attributes. When logs arrive via the
// Loki OTLP endpoint, log-record attributes (exception.type / .message /
// .stacktrace) become structured metadata with dots normalized to
// underscores. Structured metadata is usable in label filters and
// sum by (...) without a parser stage, so the queries below deliberately use
// the label-filter-only form (no | json / | logfmt): it works for structured
// metadata and avoids mis-parsing non-JSON bodies.
const (
	semconvTypeLabel    = "exception_type"
	semconvMessageLabel = "exception_message"
)

// Shape (b) — JSON-body logs. Field names surveyed from real NAV apps
// (2026-07): logback/logstash uses message+level ("ERROR"), pino/Node SSR
// uses message+level ("error", no stack_trace), Go slog and pino defaults use
// msg. Errors are matched on the parsed level field OR Loki's detected_level
// structured metadata (which also understands severity-style fields), so the
// shape does not require a stack_trace — most Node error logs carry none.
const (
	jsonMessageLabel = "message"
	jsonMsgLabel     = "msg"
)

// errorLevelRe matches error-class levels in both the parsed JSON `level`
// field and Loki's `detected_level` structured metadata.
const errorLevelRe = `(?i)(error|fatal|critical)`

// plainSampleLimit caps the shape (c) raw-line sample used to title
// unstructured (non-JSON) error groups.
const plainSampleLimit = 200

// IssueImpact summarizes the blast radius of a server issue.
// Versions is reserved for a later phase (app-version attribution needs a
// per-shape version label survey); it is always empty in Phase 1.
type IssueImpact struct {
	Pods     int      `json:"pods"`
	Versions []string `json:"versions"`
}

// Issue is one row in the unified issues list: an ExceptionGroup tagged with
// the telemetry source it was aggregated from.
type Issue struct {
	ExceptionGroup
	// Source is "browser" (Faro exceptions) or "server" (backend log exceptions).
	Source string `json:"source"`
	// Impact is set for server issues only (browser issues carry Sessions).
	Impact *IssueImpact `json:"impact,omitempty"`
}

// IssueSources reports which telemetry sides answered without error.
type IssueSources struct {
	Browser    bool `json:"browser"`
	ServerLogs bool `json:"serverLogs"`
}

// IssuesResponse is the /issues payload: browser + server issue groups
// merged into one list sorted by occurrence count.
type IssuesResponse struct {
	FingerprintVersion string       `json:"fingerprintVersion"`
	Sources            IssueSources `json:"sources"`
	Issues             []Issue      `json:"issues"`
	// SessionsWindowSeconds / SessionsUnavailable pass through from the
	// browser-side aggregation (see ExceptionGroupsResponse).
	SessionsWindowSeconds int  `json:"sessionsWindowSeconds,omitempty"`
	SessionsUnavailable   bool `json:"sessionsUnavailable,omitempty"`
	// Unavailable is set when Loki is unconfigured or both sides failed.
	Unavailable bool `json:"unavailable,omitempty"`
}

// handleIssues returns the unified issues list (#63 Phase 1): Faro frontend
// exception groups merged with backend exceptions grouped from the service's
// own Loki log streams.
// GET /services/{namespace}/{service}/issues?from=&to=&environment=
func (a *App) handleIssues(w http.ResponseWriter, req *http.Request) {
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

	lokiUID := a.settings.LogsDataSource.Resolve(env).UID
	if lokiUID == "" {
		writeJSON(w, IssuesResponse{FingerprintVersion: fingerprint.Version, Issues: []Issue{}, Unavailable: true})
		return
	}

	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("issues", orgID, namespace, service, env, roundedUnix(from), roundedUnix(to))
	dsClient := queries.NewDsQueryClient(a.grafanaURL, a.resolveServiceToken(ctx)).WithAuthHeaders(req.Header)
	a.writeCached(w, ck, "querying issues failed", func() (any, error) {
		return a.queryIssues(ctx, dsClient, lokiUID, service, env, from, to), nil
	})
}

// queryIssues fans out to the browser (Faro) and server (backend logs)
// aggregations concurrently and merges the results. One side erroring never
// fails the endpoint — the other side's issues are still returned and the
// sources flags say what happened.
func (a *App) queryIssues(ctx context.Context, ds *queries.DsQueryClient, lokiUID, service, env string, from, to time.Time) IssuesResponse {
	var (
		wg       sync.WaitGroup
		browser  ExceptionGroupsResponse
		server   []Issue
		serverOK bool
	)
	wg.Go(func() { browser = a.queryExceptionGroups(ctx, ds, lokiUID, service, env, from, to) })
	wg.Go(func() { server, serverOK = a.queryServerExceptionGroups(ctx, ds, lokiUID, service, env, from, to) })
	wg.Wait()

	issues := make([]Issue, 0, len(browser.Groups)+len(server))
	for _, g := range browser.Groups {
		issues = append(issues, Issue{ExceptionGroup: g, Source: issueSourceBrowser})
	}
	issues = append(issues, server...)

	sort.Slice(issues, func(i, j int) bool {
		if issues[i].Count != issues[j].Count {
			return issues[i].Count > issues[j].Count
		}
		if issues[i].Fingerprint != issues[j].Fingerprint {
			return issues[i].Fingerprint < issues[j].Fingerprint
		}
		return issues[i].Source < issues[j].Source
	})
	if len(issues) > maxGroups {
		issues = issues[:maxGroups]
	}

	return IssuesResponse{
		FingerprintVersion: fingerprint.Version,
		Sources: IssueSources{
			Browser:    !browser.Unavailable,
			ServerLogs: serverOK,
		},
		Issues:                issues,
		SessionsWindowSeconds: browser.SessionsWindowSeconds,
		SessionsUnavailable:   browser.SessionsUnavailable,
		Unavailable:           browser.Unavailable && !serverOK,
	}
}

// serverLogSelector builds the stream selector for a service's own backend
// logs, mirroring LogsTab.tsx: kind="" excludes Faro browser-telemetry
// streams (which carry the kind label), and the cluster label scopes
// centralized Loki to the selected environment.
func (a *App) serverLogSelector(service, env string) string {
	sel := fmt.Sprintf(`{%s="%s", %s=""`, a.otelCfg.Labels.ServiceName, service, a.otelCfg.FaroLoki.Kind)
	if env != "" {
		// env may be comma-separated multi-select — equality would match nothing.
		sel += ", " + envMatcher(a.otelCfg.Labels.DeploymentEnv, env)
	}
	return sel + "}"
}

// queryServerExceptionGroups aggregates backend exceptions from the service's
// own Loki log streams into fingerprint-keyed issue groups (#63 Phase 1).
//
// Three log shapes are probed concurrently, cataloged from real NAV
// production logs (2026-07 survey) — whichever shape returns data
// contributes rows:
//
//	(a) OTLP/semconv structured metadata:
//	    sum by (exception_type, exception_message) (count_over_time({sel} | exception_type != "" [range]))
//	(b) JSON body (logback/logstash, pino, slog):
//	    sum by (message, msg) (count_over_time({sel} | exception_type=""
//	      | json | level=~errRe or detected_level=~errRe | message != "" or msg != "" [range]))
//	    The message/msg filter also drops non-JSON lines (a failed | json
//	    leaves both empty), which keeps __error__-labeled lines out of the
//	    aggregation — Loki hard-fails metric queries that aggregate them.
//	(c) Unstructured plain text (sidecars, Next.js console output):
//	    error-level lines by detected_level that shape (b) cannot parse a
//	    message from. One count query for volume plus a raw-line sample that
//	    is fingerprinted Go-side for titles; sample counts are scaled to the
//	    counted total. Requires Loki log-level detection (detected_level);
//	    without it the shape contributes nothing and (a)/(b) still work.
//
// The exception_type="" guard on (b)/(c) keeps a line countable by exactly
// one shape, so counts never double up across shapes.
//
// Rows merge into groups by the shared fingerprint exactly like the browser
// side. MemberHashes stays empty for server issues: they have no Alloy hash;
// the drawer re-queries by fingerprint-normalized message (out of scope here).
//
// Impact is one extra query per metric shape adding the pod structured-
// metadata label to the group-by; distinct pods are counted per fingerprint.
// Impact query failures degrade to pods=0, and sampled plain-text groups
// always report pods=0 (the sample carries no pod attribution).
//
// The returned bool is false only when all shape count queries failed —
// callers then flag sources.serverLogs=false instead of failing the endpoint.
func (a *App) queryServerExceptionGroups(ctx context.Context, ds *queries.DsQueryClient, lokiUID, service, env string, from, to time.Time) ([]Issue, bool) {
	logger := log.DefaultLogger.With("handler", "issues")
	sel := a.serverLogSelector(service, env)
	window := lokiWindow(from, to)

	semconvFilter := fmt.Sprintf(`%s != ""`, semconvTypeLabel)
	jsonFilter := fmt.Sprintf(`%s="" | json | level=~"%s" or detected_level=~"%s" | %s != "" or %s != ""`,
		semconvTypeLabel, errorLevelRe, errorLevelRe, jsonMessageLabel, jsonMsgLabel)
	// drop __error__ keeps parse-failed (non-JSON) lines flowing into the
	// aggregation instead of hard-failing the query; the empty message/msg
	// filters then select exactly the lines shape (b) could not title.
	plainPipeline := fmt.Sprintf(`%s | detected_level=~"%s" | %s="" | json | drop __error__, __error_details__ | %s="" | %s=""`,
		sel, errorLevelRe, semconvTypeLabel, jsonMessageLabel, jsonMsgLabel)

	countSemconv := fmt.Sprintf(`sum by (%s, %s) (count_over_time(%s | %s %s))`,
		semconvTypeLabel, semconvMessageLabel, sel, semconvFilter, window)
	podsSemconv := fmt.Sprintf(`sum by (%s, %s, %s) (count_over_time(%s | %s %s))`,
		semconvTypeLabel, semconvMessageLabel, podLabel, sel, semconvFilter, window)
	countJSON := fmt.Sprintf(`sum by (%s, %s) (count_over_time(%s | %s %s))`,
		jsonMessageLabel, jsonMsgLabel, sel, jsonFilter, window)
	podsJSON := fmt.Sprintf(`sum by (%s, %s, %s) (count_over_time(%s | %s %s))`,
		jsonMessageLabel, jsonMsgLabel, podLabel, sel, jsonFilter, window)
	countPlain := fmt.Sprintf(`sum(count_over_time(%s %s))`, plainPipeline, window)

	var (
		wg                                       sync.WaitGroup
		semRes, semPodsRes, jsonRes, jsonPodsRes []queries.PromResult
		plainRes                                 []queries.PromResult
		plainSample                              []queries.LogEntry
		semErr, semPodsErr, jsonErr, jsonPodsErr error
		plainErr, plainSampleErr                 error
	)
	wg.Go(func() { semRes, semErr = ds.InstantQuery(ctx, lokiUID, countSemconv, to) })
	wg.Go(func() { semPodsRes, semPodsErr = ds.InstantQuery(ctx, lokiUID, podsSemconv, to) })
	wg.Go(func() { jsonRes, jsonErr = ds.InstantQuery(ctx, lokiUID, countJSON, to) })
	wg.Go(func() { jsonPodsRes, jsonPodsErr = ds.InstantQuery(ctx, lokiUID, podsJSON, to) })
	wg.Go(func() { plainRes, plainErr = ds.InstantQuery(ctx, lokiUID, countPlain, to) })
	wg.Go(func() {
		plainSample, plainSampleErr = ds.LogQuery(ctx, lokiUID, plainPipeline, from, to, plainSampleLimit)
	})
	wg.Wait()

	if semErr != nil {
		logger.Warn("Server exceptions semconv query failed", "error", semErr)
	}
	if jsonErr != nil {
		logger.Warn("Server exceptions json query failed", "error", jsonErr)
	}
	if plainErr != nil {
		logger.Warn("Server exceptions plain-text query failed", "error", plainErr)
	}
	if semErr != nil && jsonErr != nil && plainErr != nil {
		return nil, false
	}
	if semPodsErr != nil {
		logger.Warn("Server exceptions semconv pods query failed", "error", semPodsErr)
	}
	if jsonPodsErr != nil {
		logger.Warn("Server exceptions json pods query failed", "error", jsonPodsErr)
	}
	if plainSampleErr != nil {
		logger.Warn("Server exceptions plain-text sample query failed", "error", plainSampleErr)
	}

	groups := make(map[string]*Issue)
	seenType := make(map[string]map[string]bool) // fingerprint -> type set
	add := func(exType, msg string, count float64) {
		if msg == "" && exType == "" {
			return // an empty event fingerprints to a meaningless catch-all group
		}
		fp := fingerprint.Compute(fingerprint.Event{Type: exType, Value: msg})
		g, ok := groups[fp.Value]
		if !ok {
			g = &Issue{
				ExceptionGroup: ExceptionGroup{
					Fingerprint:  fp.Value,
					Tier:         int(fp.Tier),
					Title:        fp.Title,
					MemberHashes: []string{},
				},
				Source: issueSourceServer,
			}
			groups[fp.Value] = g
			seenType[fp.Value] = make(map[string]bool)
		}
		g.Count += count
		if exType != "" && !seenType[fp.Value][exType] {
			seenType[fp.Value][exType] = true
			g.Types = append(g.Types, exType)
		}
	}
	// jsonRowMessage picks the populated body field: logback/pino emit
	// `message`, slog and default pino emit `msg`.
	jsonRowMessage := func(m map[string]string) string {
		if v := m[jsonMessageLabel]; v != "" {
			return v
		}
		return m[jsonMsgLabel]
	}
	if semErr == nil {
		for _, r := range semRes {
			add(r.Metric[semconvTypeLabel], r.Metric[semconvMessageLabel], r.Value.Float())
		}
	}
	if jsonErr == nil {
		for _, r := range jsonRes {
			add("", jsonRowMessage(r.Metric), r.Value.Float())
		}
	}
	if plainErr == nil && plainSampleErr == nil && len(plainSample) > 0 {
		addPlainTextGroups(plainRes, plainSample, add)
	}

	// Distinct pods per fingerprint: fingerprint the impact rows the same way
	// so pod sets land on the groups built above.
	podsByFP := make(map[string]map[string]bool)
	addPod := func(exType, msg, pod string) {
		if pod == "" || (msg == "" && exType == "") {
			return
		}
		fp := fingerprint.Compute(fingerprint.Event{Type: exType, Value: msg})
		if podsByFP[fp.Value] == nil {
			podsByFP[fp.Value] = make(map[string]bool)
		}
		podsByFP[fp.Value][pod] = true
	}
	if semPodsErr == nil {
		for _, r := range semPodsRes {
			addPod(r.Metric[semconvTypeLabel], r.Metric[semconvMessageLabel], r.Metric[podLabel])
		}
	}
	if jsonPodsErr == nil {
		for _, r := range jsonPodsRes {
			addPod("", jsonRowMessage(r.Metric), r.Metric[podLabel])
		}
	}

	out := make([]Issue, 0, len(groups))
	for _, g := range groups {
		sort.Strings(g.Types)
		g.Impact = &IssueImpact{Pods: len(podsByFP[g.Fingerprint]), Versions: []string{}}
		out = append(out, *g)
	}
	return out, true
}

// trimSpaceLimited trims whitespace and caps a raw sampled log line before
// fingerprinting: multi-KB lines (giant stack dumps) fingerprint identically
// on their lead text, and fingerprint.Normalize truncates titles anyway.
func trimSpaceLimited(line string) string {
	const maxFingerprintInput = 1024
	s := strings.TrimSpace(line)
	if len(s) > maxFingerprintInput {
		s = s[:maxFingerprintInput]
	}
	return s
}

// addPlainTextGroups folds shape (c) — plain-text loggers — into the group
// map: the count query carries the volume, the sample carries the titles.
// The counted total is distributed across the sampled lines proportionally —
// exact when the sample is complete, honest otherwise.
func addPlainTextGroups(plainRes []queries.PromResult, plainSample []queries.LogEntry, add func(exType, msg string, count float64)) {
	var plainTotal float64
	for _, r := range plainRes {
		plainTotal += r.Value.Float()
	}
	sampleCounts := make(map[string]float64)
	for _, entry := range plainSample {
		if line := trimSpaceLimited(entry.Line); line != "" {
			sampleCounts[line]++
		}
	}
	var sampleTotal float64
	for _, c := range sampleCounts {
		sampleTotal += c
	}
	if plainTotal <= 0 {
		plainTotal = sampleTotal
	}
	for line, c := range sampleCounts {
		if sampleTotal > 0 {
			add("", line, roundTo(plainTotal*c/sampleTotal, 0))
		}
	}
}
