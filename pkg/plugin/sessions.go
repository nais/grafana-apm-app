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

	// Total Faro lines per session over ALL kinds — one aggregate query keeps
	// the series set at one per session instead of session × kind × page.
	eventsExpr := func(window string) string {
		return fmt.Sprintf(
			`sum by (%[1]s) (count_over_time(%[2]s | logfmt | %[1]s!="" | keep %[1]s %[3]s))`,
			fl.SessionID, allStream, window,
		)
	}
	// Exception occurrences per session.
	errorsExpr := func(window string) string {
		return fmt.Sprintf(
			`sum by (%[1]s) (count_over_time(%[2]s | logfmt | %[1]s!="" | keep %[1]s %[3]s))`,
			fl.SessionID, excStream, window,
		)
	}
	// Raw recent lines carrying session context — parsed server-side for
	// user/browser/version/page metadata and first/last-seen timestamps.
	metaExpr := fmt.Sprintf(`%s | logfmt | %s!=""`, allStream, fl.SessionID)

	var (
		wg                 sync.WaitGroup
		eventsRes, errsRes []queries.PromResult
		metaRes            []queries.LogEntry
		eventsErr, errsErr error
		metaErr            error
		eventsWin, errsWin int
	)
	wg.Go(func() {
		eventsRes, eventsWin, eventsErr = instantWithSessionFallback(ctx, ds, lokiUID, eventsExpr, from, to)
	})
	wg.Go(func() {
		errsRes, errsWin, errsErr = instantWithSessionFallback(ctx, ds, lokiUID, errorsExpr, from, to)
	})
	wg.Go(func() { metaRes, metaErr = ds.LogQuery(ctx, lokiUID, metaExpr, from, to, sessionMetaLimit) })
	wg.Wait()

	if eventsErr != nil {
		logger.Warn("Session events query failed", "error", eventsErr)
		return FrontendSessionsResponse{Sessions: []SessionSummary{}, Unavailable: true}
	}
	if errsErr != nil {
		logger.Warn("Session errors query failed", "error", errsErr)
	}
	if metaErr != nil {
		logger.Warn("Session metadata query failed", "error", metaErr)
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

	for _, r := range eventsRes {
		if id := r.Metric[fl.SessionID]; id != "" {
			get(id).Events += r.Value.Float()
		}
	}
	for _, r := range errsRes {
		if id := r.Metric[fl.SessionID]; id != "" {
			get(id).Errors += r.Value.Float()
		}
	}

	// Enrich from the raw lines: newest-first, so take the first non-empty
	// value per field (most recent context wins) and track seen page URLs.
	pagesBySession := make(map[string]map[string]bool)
	for _, entry := range metaRes {
		fields := parseLogfmt(entry.Line)
		id := fields[fl.SessionID]
		if id == "" {
			continue
		}
		s := get(id)
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
		sessions[id].Pages = len(pages)
	}

	out := make([]SessionSummary, 0, len(sessions))
	for _, s := range sessions {
		if matchesSessionQuery(s, q) {
			out = append(out, *s)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Errors != out[j].Errors {
			return out[i].Errors > out[j].Errors
		}
		if out[i].LastSeenMs != out[j].LastSeenMs {
			return out[i].LastSeenMs > out[j].LastSeenMs
		}
		return out[i].SessionID < out[j].SessionID
	})
	truncated := len(out) > maxSessions
	if truncated {
		out = out[:maxSessions]
	}

	windowSecs := eventsWin
	if windowSecs == 0 {
		windowSecs = errsWin
	}
	return FrontendSessionsResponse{Sessions: out, Truncated: truncated, WindowSeconds: windowSecs}
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
