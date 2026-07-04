package plugin

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// feedbackEventName is the Faro event name @nais/apm's captureFeedback()
// pushes (sdk/src/feedback.ts) — the wire contract this reader is built
// against.
const feedbackEventName = "faro.feedback"

// Faro's Alloy receiver logfmt-encodes event attributes under an
// "event_data_" prefix (verified against live kind=event lines, e.g.
// event_data_duration on faro.performance.resource); session_id, page_url
// and app_version ride at the top level of the same line.
const eventDataPrefix = "event_data_"

// Response cap: feedback is a raw log read (no aggregation to rank by), so
// cap the payload like the other raw-line handlers (M6 seed).
const maxFeedback = 200

// FeedbackEntry is one piece of user feedback captured via
// `@nais/apm`'s captureFeedback() (M6 seed).
type FeedbackEntry struct {
	TimeMs      int64  `json:"timeMs"`
	Message     string `json:"message"`
	Category    string `json:"category"`
	Email       string `json:"email,omitempty"`
	SessionID   string `json:"sessionId,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
	PageURL     string `json:"pageUrl,omitempty"`
	AppVersion  string `json:"appVersion,omitempty"`
}

// FeedbackResponse is the /feedback payload.
type FeedbackResponse struct {
	Feedback []FeedbackEntry `json:"feedback"`
	// Unavailable indicates Loki is not configured/reachable for this env.
	Unavailable bool `json:"unavailable,omitempty"`
}

// handleFeedback returns recent user feedback for a frontend app, optionally
// scoped to a session or joined to an issue via fingerprint.
// GET /services/{namespace}/{service}/feedback?from=&to=&sessionId=&fingerprint=
func (a *App) handleFeedback(w http.ResponseWriter, req *http.Request) {
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
	sessionID := strings.TrimSpace(req.URL.Query().Get("sessionId"))
	fingerprint := strings.TrimSpace(req.URL.Query().Get("fingerprint"))

	lokiUID := a.settings.LogsDataSource.Resolve(env).UID
	if lokiUID == "" {
		writeJSON(w, FeedbackResponse{Feedback: []FeedbackEntry{}, Unavailable: true})
		return
	}

	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("feedback", orgID, namespace, service, env, roundedUnix(from), roundedUnix(to), sessionID, fingerprint)
	dsClient := queries.NewDsQueryClient(a.grafanaURL, a.resolveServiceToken(ctx)).WithAuthHeaders(req.Header)

	a.writeCached(w, ck, "querying feedback failed", func() (any, error) {
		return a.queryFeedback(ctx, dsClient, lokiUID, service, env, from, to, sessionID, fingerprint), nil
	})
}

// queryFeedback fetches faro.feedback events for a service, newest first.
func (a *App) queryFeedback(ctx context.Context, ds *queries.DsQueryClient, lokiUID, service, env string, from, to time.Time, sessionID, fingerprint string) FeedbackResponse {
	logger := log.DefaultLogger.With("handler", "feedback")
	fl := a.otelCfg.FaroLoki
	stream := a.otelCfg.LokiStreamSelector(service, fl.KindEvent, env)

	// `|= "event_name=..."` is a cheap line filter applied before logfmt
	// parsing (mirrors the replay-chunk relabeling match in the Alloy Faro
	// pipeline) — the event stream carries every kind="event" line for the
	// service, most of which aren't feedback.
	expr := fmt.Sprintf(`%s |= "event_name=%s" | logfmt | event_name="%s"`, stream, feedbackEventName, feedbackEventName)
	if sessionID != "" {
		expr += fmt.Sprintf(` | %s="%s"`, fl.SessionID, sanitizeSessionID(sessionID))
	}
	if fingerprint != "" {
		expr += fmt.Sprintf(` | %sfingerprint="%s"`, eventDataPrefix, sanitizeFingerprintFilter(fingerprint))
	}

	entries, err := ds.LogQuery(ctx, lokiUID, expr, from, to, maxFeedback)
	if err != nil {
		logger.Warn("Feedback query failed", "error", err)
		return FeedbackResponse{Feedback: []FeedbackEntry{}, Unavailable: true}
	}

	out := make([]FeedbackEntry, 0, len(entries))
	for _, entry := range entries {
		fields := parseLogfmt(entry.Line)
		out = append(out, FeedbackEntry{
			TimeMs:      entry.TimeMs,
			Message:     fields[eventDataPrefix+"message"],
			Category:    fields[eventDataPrefix+"category"],
			Email:       fields[eventDataPrefix+"email"],
			SessionID:   fields[fl.SessionID],
			Fingerprint: fields[eventDataPrefix+"fingerprint"],
			PageURL:     fields[fl.PageURL],
			AppVersion:  fields[fl.AppVersion],
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TimeMs > out[j].TimeMs })
	if len(out) > maxFeedback {
		out = out[:maxFeedback]
	}

	return FeedbackResponse{Feedback: out}
}

// sanitizeFingerprintFilter keeps regex-safe fingerprint characters —
// versioned fingerprints look like "v1:9f2ab31c04d7e655" (fingerprint.Value)
// — anything else is stripped rather than escaped.
func sanitizeFingerprintFilter(fp string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == ':':
			return r
		}
		return -1
	}, fp)
}
