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

// Response cap: sessions are sorted by error count then recency, and busy
// apps see thousands of sessions per hour — cap the payload (M5).
const maxSessions = 50

// Metadata harvest cap: user/browser/version/page context comes from a raw
// backward log query; 500 recent lines is enough to enrich the sessions the
// list can show without hammering Loki.
const sessionMetaLimit = 500

// Faro logfmt field names not modeled in otelconfig.FaroLoki — user identity
// and OS ride on every Faro line under these keys.
const (
	faroUserID    = "user_id"
	faroUserEmail = "user_email"
	faroBrowserOS = "browser_os"
)

// SessionSummary is one Faro session with error/activity counts and the
// user/browser context harvested from recent log lines (M5).
type SessionSummary struct {
	SessionID string `json:"sessionId"`
	// FirstSeenMs/LastSeenMs bound the session activity observed in the
	// metadata harvest (epoch ms); 0 when no raw lines were seen for it.
	FirstSeenMs int64 `json:"firstSeenMs"`
	LastSeenMs  int64 `json:"lastSeenMs"`
	// Events is the total Faro lines (all kinds) for the session in range.
	Events float64 `json:"events"`
	// Errors is the exception count for the session in range.
	Errors     float64 `json:"errors"`
	UserID     string  `json:"userId"`
	UserEmail  string  `json:"userEmail"`
	Browser    string  `json:"browser"`
	OS         string  `json:"os"`
	AppVersion string  `json:"appVersion"`
	// Pages is the count of distinct page URLs seen in the metadata harvest.
	Pages int `json:"pages"`
}

// FrontendSessionsResponse is the /frontend/sessions payload.
type FrontendSessionsResponse struct {
	Sessions []SessionSummary `json:"sessions"`
	// Truncated is set when more sessions matched than the response cap.
	Truncated bool `json:"truncated"`
	// Unavailable indicates Loki is not configured/reachable for this env.
	Unavailable bool `json:"unavailable"`
	// WindowSeconds is set when the per-session counts had to be computed
	// over a narrower window than the requested range (Loki max_query_series
	// on the session_id series set), mirroring ExceptionGroupsResponse.
	WindowSeconds int `json:"windowSeconds,omitempty"`
}

// handleFrontendSessions returns recent Faro sessions for a frontend app.
// GET /services/{namespace}/{service}/frontend/sessions?from=&to=&environment=&q=
func (a *App) handleFrontendSessions(w http.ResponseWriter, req *http.Request) {
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
	q := strings.TrimSpace(req.URL.Query().Get("q"))

	lokiUID := a.settings.LogsDataSource.Resolve(env).UID
	if lokiUID == "" {
		writeJSON(w, FrontendSessionsResponse{Sessions: []SessionSummary{}, Unavailable: true})
		return
	}

	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("frontendsessions", orgID, namespace, service, env, roundedUnix(from), roundedUnix(to), strings.ToLower(q))
	dsClient := queries.NewDsQueryClient(a.grafanaURL, a.resolveServiceToken(ctx)).WithAuthHeaders(req.Header)

	a.writeCached(w, ck, "querying frontend sessions failed", func() (any, error) {
		return a.queryFrontendSessions(ctx, dsClient, lokiUID, service, env, from, to, q), nil
	})
}

func (a *App) queryFrontendSessions(ctx context.Context, ds *queries.DsQueryClient, lokiUID, service, env string, from, to time.Time, q string) FrontendSessionsResponse {
	logger := log.DefaultLogger.With("handler", "frontend-sessions")
	fl := a.otelCfg.FaroLoki
	allStream := a.otelCfg.LokiStreamSelector(service, "", env)
	excStream := a.otelCfg.LokiStreamSelector(service, fl.KindException, env)

	// Phase 1 — errors per session over the exception stream (the cheap one)
	// drives everything: it picks the top sessions AND the effective window,
	// so every other column is computed over the SAME window. Running the
	// queries independently produced incoherent rows ("0 events, 30 errors")
	// whenever their series-limit fallbacks landed on different rungs.
	errorsExpr := func(window string) string {
		return fmt.Sprintf(
			`sum by (%[1]s) (count_over_time(%[2]s | logfmt | %[1]s!="" | keep %[1]s %[3]s))`,
			fl.SessionID, excStream, window,
		)
	}
	errsRes, winSecs, errsErr := instantWithSessionFallback(ctx, ds, lokiUID, errorsExpr, from, to)
	if errsErr != nil {
		logger.Warn("Session errors query failed", "error", errsErr)
		return FrontendSessionsResponse{Sessions: []SessionSummary{}, Unavailable: true}
	}

	sessions := make(map[string]*SessionSummary)
	get := func(id string) *SessionSummary {
		s, ok := sessions[id]
		if !ok {
			s = &SessionSummary{SessionID: id}
			sessions[id] = s
		}
		return s
	}
	for _, r := range errsRes {
		if id := r.Metric[fl.SessionID]; id != "" {
			get(id).Errors += r.Value.Float()
		}
	}

	// Top sessions by errors — the only entry point this panel promises.
	// Sessions without errors in the window are out of scope by design.
	ranked := make([]*SessionSummary, 0, len(sessions))
	for _, s := range sessions {
		ranked = append(ranked, s)
	}
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].Errors != ranked[j].Errors {
			return ranked[i].Errors > ranked[j].Errors
		}
		return ranked[i].SessionID < ranked[j].SessionID
	})
	truncated := len(ranked) > maxSessions
	if truncated {
		ranked = ranked[:maxSessions]
	}
	if len(ranked) == 0 {
		return FrontendSessionsResponse{Sessions: []SessionSummary{}, WindowSeconds: winSecs}
	}

	// Effective range matching the errors window.
	effFrom := from
	if winSecs > 0 {
		effFrom = to.Add(-time.Duration(winSecs) * time.Second)
	}

	// Phase 2 — events + metadata scoped to exactly these session ids: the
	// series set is bounded (≤ maxSessions) so no fallback ladder is needed,
	// and every fetched metadata line is relevant (a global newest-500 sample
	// covers seconds of a chatty app and left the whole table dashed out).
	ids := make([]string, 0, len(ranked))
	for _, s := range ranked {
		ids = append(ids, sanitizeSessionID(s.SessionID))
	}
	alt := strings.Join(ids, "|")
	eventsExpr := fmt.Sprintf(
		"sum by (%[1]s) (count_over_time(%[2]s |~ `%[1]s=(%[3]s)` | logfmt | %[1]s=~\"(%[3]s)\" | keep %[1]s %[4]s))",
		fl.SessionID, allStream, alt, lokiWindow(effFrom, to),
	)
	metaExpr := fmt.Sprintf("%[2]s |~ `%[1]s=(%[3]s)` | logfmt | %[1]s=~\"(%[3]s)\"", fl.SessionID, allStream, alt)

	var (
		wg        sync.WaitGroup
		eventsRes []queries.PromResult
		metaRes   []queries.LogEntry
		eventsErr error
		metaErr   error
	)
	wg.Go(func() { eventsRes, eventsErr = ds.InstantQuery(ctx, lokiUID, eventsExpr, to) })
	wg.Go(func() { metaRes, metaErr = ds.LogQuery(ctx, lokiUID, metaExpr, effFrom, to, sessionMetaLimit) })
	wg.Wait()
	if eventsErr != nil {
		logger.Warn("Session events query failed", "error", eventsErr)
	}
	if metaErr != nil {
		logger.Warn("Session metadata query failed", "error", metaErr)
	}

	for _, r := range eventsRes {
		if id := r.Metric[fl.SessionID]; id != "" {
			if s, ok := sessions[id]; ok {
				s.Events += r.Value.Float()
			}
		}
	}

	// Enrich from the raw lines: newest-first, so take the first non-empty
	// value per field (most recent context wins) and track seen page URLs.
	pagesBySession := make(map[string]map[string]bool)
	for _, entry := range metaRes {
		fields := parseLogfmt(entry.Line)
		id := fields[fl.SessionID]
		s, ok := sessions[id]
		if !ok {
			continue
		}
		if s.FirstSeenMs == 0 || entry.TimeMs < s.FirstSeenMs {
			s.FirstSeenMs = entry.TimeMs
		}
		if entry.TimeMs > s.LastSeenMs {
			s.LastSeenMs = entry.TimeMs
		}
		setIfEmpty(&s.UserID, fields[faroUserID])
		setIfEmpty(&s.UserEmail, fields[faroUserEmail])
		setIfEmpty(&s.Browser, fields[fl.BrowserName])
		setIfEmpty(&s.OS, fields[faroBrowserOS])
		setIfEmpty(&s.AppVersion, fields[fl.AppVersion])
		if page := fields[fl.PageURL]; page != "" {
			if pagesBySession[id] == nil {
				pagesBySession[id] = make(map[string]bool)
			}
			pagesBySession[id][page] = true
		}
	}
	for id, pages := range pagesBySession {
		if s, ok := sessions[id]; ok {
			s.Pages = len(pages)
		}
	}

	// The q filter applies to the enriched top set — sessions outside the
	// top-by-errors are not searchable here by design (this is an error-first
	// entry point, not a full session store).
	out := make([]SessionSummary, 0, len(ranked))
	for _, s := range ranked {
		if matchesSessionQuery(s, q) {
			out = append(out, *s)
		}
	}

	return FrontendSessionsResponse{Sessions: out, Truncated: truncated, WindowSeconds: winSecs}
}

// sanitizeSessionID keeps regex-safe characters only — Faro session ids are
// alphanumeric, so anything else is stripped rather than escaped.
func sanitizeSessionID(id string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		}
		return -1
	}, id)
}

// instantWithSessionFallback runs an instant query built for the full range,
// walking the sessionsFallbackWindows ladder when Loki rejects it (the
// session_id series set exceeds max_query_series on wide ranges for chatty
// apps). Returns the narrowed window in seconds when a fallback rung won.
func instantWithSessionFallback(ctx context.Context, ds *queries.DsQueryClient, lokiUID string, expr func(window string) string, from, to time.Time) ([]queries.PromResult, int, error) {
	res, err := ds.InstantQuery(ctx, lokiUID, expr(lokiWindow(from, to)), to)
	if err == nil {
		return res, 0, nil
	}
	for _, w := range sessionsFallbackWindows {
		if to.Sub(from) <= w {
			continue
		}
		res, err = ds.InstantQuery(ctx, lokiUID, expr(lokiWindow(to.Add(-w), to)), to)
		if err == nil {
			return res, int(w.Seconds()), nil
		}
	}
	return nil, 0, err
}

// matchesSessionQuery reports whether a session matches the free-text filter:
// case-insensitive substring over session id, user id, and user email.
func matchesSessionQuery(s *SessionSummary, q string) bool {
	if q == "" {
		return true
	}
	needle := strings.ToLower(q)
	return strings.Contains(strings.ToLower(s.SessionID), needle) ||
		strings.Contains(strings.ToLower(s.UserID), needle) ||
		strings.Contains(strings.ToLower(s.UserEmail), needle)
}

func setIfEmpty(dst *string, v string) {
	if *dst == "" && v != "" {
		*dst = v
	}
}

// parseLogfmt extracts key=value pairs from a logfmt line. Values may be
// bare (up to the next space) or double-quoted with backslash escapes —
// enough for Faro's Loki exporter output; no external logfmt dependency.
func parseLogfmt(line string) map[string]string {
	fields := make(map[string]string)
	i, n := 0, len(line)
	for i < n {
		// Skip whitespace between pairs.
		for i < n && line[i] == ' ' {
			i++
		}
		start := i
		for i < n && line[i] != '=' && line[i] != ' ' {
			i++
		}
		key := line[start:i]
		if i >= n || line[i] != '=' {
			continue // bare token without a value
		}
		i++ // consume '='
		var value string
		if i < n && line[i] == '"' {
			i++
			var b strings.Builder
			for i < n && line[i] != '"' {
				if line[i] == '\\' && i+1 < n {
					i++
				}
				b.WriteByte(line[i])
				i++
			}
			i++ // consume closing quote (or run past end)
			value = b.String()
		} else {
			start = i
			for i < n && line[i] != ' ' {
				i++
			}
			value = line[start:i]
		}
		if key != "" {
			fields[key] = value
		}
	}
	return fields
}
