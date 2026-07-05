package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// Triage state lives as an append-only event log in Grafana organization
// annotations (#57 Phase 1): annotations sit in Grafana's shared database, so
// state is HA-safe across plugin replicas with zero new infrastructure, and
// the log doubles as the audit history. State is folded newest-event-wins at
// read time. Deployment requirement: [annotations.api] retention must stay at
// keep-all — see docs/triage.md and checkAnnotationRetention below.

const (
	triageTag       = "nais-apm:triage"
	maxTriageEvents = 1000
	// maxTriagePages bounds pagination: 10k events per service is far beyond
	// any observed history and keeps a pathological loop finite.
	maxTriagePages = 10
)

var fingerprintRe = regexp.MustCompile(`^[a-z0-9:]{1,64}$`)

// TriageEvent is one append-only entry in the event log (the annotation text).
type TriageEvent struct {
	Schema            int    `json:"schema"`
	Action            string `json:"action"` // resolve | ignore | unresolve | assign
	Actor             string `json:"actor"`
	Assignee          string `json:"assignee,omitempty"`
	ResolvedInVersion string `json:"resolvedInVersion,omitempty"`
	Note              string `json:"note,omitempty"`
	// TimeMs is filled from the annotation timestamp on read.
	TimeMs int64 `json:"timeMs,omitempty"`
}

// TriageState is the folded current state for one fingerprint.
type TriageState struct {
	Status            string `json:"status"` // active | resolved | ignored
	Assignee          string `json:"assignee,omitempty"`
	ResolvedInVersion string `json:"resolvedInVersion,omitempty"`
	UpdatedAt         int64  `json:"updatedAt"`
	UpdatedBy         string `json:"updatedBy"`
}

// TriageStore abstracts the storage engine so the annotations event log can
// be swapped for a real database later (#57 Phase 2) by replaying the log.
type TriageStore interface {
	States(ctx context.Context, namespace, service string) (map[string]TriageState, error)
	Record(ctx context.Context, namespace, service, fingerprint string, ev TriageEvent) error
	History(ctx context.Context, namespace, service, fingerprint string) ([]TriageEvent, error)
}

// annotationTriageStore implements TriageStore over the Grafana annotations
// HTTP API (org-wide annotations: no dashboardUID) with the service token.
type annotationTriageStore struct {
	grafanaURL string
	token      string
	httpClient *http.Client
}

var _ TriageStore = (*annotationTriageStore)(nil)

func (a *App) triageStore(ctx context.Context) *annotationTriageStore {
	return &annotationTriageStore{
		grafanaURL: a.grafanaURL,
		token:      a.resolveServiceToken(ctx),
		httpClient: a.healthClient,
	}
}

func triageAppTag(namespace, service string) string {
	return fmt.Sprintf("app:%s/%s", namespace, service)
}

// triageFpTag encodes the fingerprint into a tag. Grafana treats tags as
// key:value pairs and truncates at the second colon, so the fingerprint's
// own colon (v1:abc…) is mapped to '-' — bijective because the fingerprint
// alphabet (^[a-z0-9:]+$) never contains '-'.
func triageFpTag(fingerprint string) string {
	return "fp:" + strings.ReplaceAll(fingerprint, ":", "-")
}

func fpFromTag(tag string) string {
	return strings.ReplaceAll(strings.TrimPrefix(tag, "fp:"), "-", ":")
}

func (s *annotationTriageStore) do(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, s.grafanaURL+path, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}
	return s.httpClient.Do(req)
}

// fetch reads triage annotations matching all given tags, newest first (the
// annotations API sorts descending by time).
// fetch reads triage annotations for the given tag set. Two scale measures
// from the 2026-07 audit (ADR-0001 appendix):
//
//   - The ultra-common triageTag is NOT sent to the API — Grafana's multi-tag
//     AND filter scans the popular-tag set, coupling every read to org-wide
//     triage volume (measured 31ms@1k -> 1.5s@50k events). We query by the
//     rare tags (app:/fp:) and verify triageTag client-side instead.
//   - Reads paginate past the per-request cap: the newest-1000 window
//     silently dropped older resolves on heavily-triaged services (the
//     fold then reported them active).
func (s *annotationTriageStore) fetch(ctx context.Context, tags []string) ([]grafanaAnnotation, error) {
	queryTags := make([]string, 0, len(tags))
	for _, tg := range tags {
		if tg != triageTag {
			queryTags = append(queryTags, tg)
		}
	}

	var out []grafanaAnnotation
	to := time.Now().UnixMilli()
	for page := 0; page < maxTriagePages; page++ {
		q := url.Values{}
		for _, tg := range queryTags {
			q.Add("tags", tg)
		}
		q.Set("limit", strconv.Itoa(maxTriageEvents))
		q.Set("from", "0")
		q.Set("to", strconv.FormatInt(to, 10))

		resp, err := s.do(ctx, http.MethodGet, "/api/annotations?"+q.Encode(), nil)
		if err != nil {
			return nil, fmt.Errorf("fetching triage annotations: %w", err)
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
		_ = resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("reading triage annotations: %w", err)
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("annotations API returned %d: %s", resp.StatusCode, truncateStr(string(raw)))
		}
		var anns []grafanaAnnotation
		if err := json.Unmarshal(raw, &anns); err != nil {
			return nil, fmt.Errorf("unmarshaling annotations: %w", err)
		}
		for _, ann := range anns {
			if hasTag(ann.Tags, triageTag) {
				out = append(out, ann)
			}
		}
		if len(anns) < maxTriageEvents {
			return out, nil
		}
		// Full page: older events may remain — continue below the oldest
		// timestamp seen (results are newest-first).
		oldest := anns[len(anns)-1].Time
		if oldest >= to {
			return out, nil
		}
		to = oldest
	}
	return out, nil
}

func hasTag(tags []string, want string) bool {
	for _, tg := range tags {
		if tg == want {
			return true
		}
	}
	return false
}

func parseTriageEvent(ann grafanaAnnotation) (fp string, ev TriageEvent, ok bool) {
	for _, t := range ann.Tags {
		if strings.HasPrefix(t, "fp:") {
			fp = fpFromTag(t)
		}
	}
	if fp == "" {
		return "", TriageEvent{}, false
	}
	if err := json.Unmarshal([]byte(ann.Text), &ev); err != nil || ev.Action == "" {
		return "", TriageEvent{}, false
	}
	ev.TimeMs = ann.Time
	return fp, ev, true
}

// States folds the event log newest-wins per fingerprint. Status events
// (resolve/ignore/unresolve) and assign events fold independently: assigning
// an issue never flips its status.
func (s *annotationTriageStore) States(ctx context.Context, namespace, service string) (map[string]TriageState, error) {
	anns, err := s.fetch(ctx, []string{triageTag, triageAppTag(namespace, service)})
	if err != nil {
		return nil, err
	}
	states := make(map[string]TriageState)
	statusSet := make(map[string]bool)
	assigneeSet := make(map[string]bool)
	// anns arrive newest first — the first status/assign event per fp wins.
	for _, ann := range anns {
		fp, ev, ok := parseTriageEvent(ann)
		if !ok {
			continue
		}
		st := states[fp]
		if st.Status == "" {
			st.Status = "active"
		}
		switch ev.Action {
		case "resolve", "ignore", "unresolve":
			if !statusSet[fp] {
				statusSet[fp] = true
				st.Status = map[string]string{"resolve": "resolved", "ignore": "ignored", "unresolve": "active"}[ev.Action]
				st.ResolvedInVersion = ev.ResolvedInVersion
				if ev.TimeMs > st.UpdatedAt {
					st.UpdatedAt = ev.TimeMs
					st.UpdatedBy = ev.Actor
				}
			}
		case "assign":
			if !assigneeSet[fp] {
				assigneeSet[fp] = true
				st.Assignee = ev.Assignee
				if ev.TimeMs > st.UpdatedAt {
					st.UpdatedAt = ev.TimeMs
					st.UpdatedBy = ev.Actor
				}
			}
		}
		states[fp] = st
	}
	return states, nil
}

// Record appends one event to the log.
func (s *annotationTriageStore) Record(ctx context.Context, namespace, service, fingerprint string, ev TriageEvent) error {
	ev.Schema = 1
	text, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("marshaling triage event: %w", err)
	}
	payload, err := json.Marshal(map[string]any{
		"time": time.Now().UnixMilli(),
		"text": string(text),
		"tags": []string{triageTag, triageAppTag(namespace, service), triageFpTag(fingerprint)},
	})
	if err != nil {
		return err
	}
	resp, err := s.do(ctx, http.MethodPost, "/api/annotations", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("writing triage annotation: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("annotations API returned %d: %s", resp.StatusCode, string(raw))
	}
	return nil
}

// History returns the full event log for one fingerprint, oldest first.
func (s *annotationTriageStore) History(ctx context.Context, namespace, service, fingerprint string) ([]TriageEvent, error) {
	anns, err := s.fetch(ctx, []string{triageTag, triageAppTag(namespace, service), triageFpTag(fingerprint)})
	if err != nil {
		return nil, err
	}
	events := make([]TriageEvent, 0, len(anns))
	for _, ann := range anns {
		if _, ev, ok := parseTriageEvent(ann); ok {
			events = append(events, ev)
		}
	}
	sort.Slice(events, func(i, j int) bool { return events[i].TimeMs < events[j].TimeMs })
	return events, nil
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

type triageStatesResponse struct {
	States map[string]TriageState `json:"states"`
}

// handleTriageStates — GET /services/{namespace}/{service}/triage
// Deliberately uncached: read-after-write matters more than saving one
// indexed Grafana DB query, and eventual consistency across replicas stays
// within the annotation write itself (shared DB).
func (a *App) handleTriageStates(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	namespace, service := parseServiceRef(req)
	if !requireServiceParam(w, service) {
		return
	}
	states, err := a.triageStore(ctx).States(ctx, namespace, service)
	if err != nil {
		log.DefaultLogger.Warn("Triage states read failed", "error", err)
		http.Error(w, `{"error":"reading triage state failed"}`, http.StatusBadGateway)
		return
	}
	writeJSON(w, triageStatesResponse{States: states})
}

type triageActionRequest struct {
	Action            string `json:"action"`
	Assignee          string `json:"assignee,omitempty"`
	ResolvedInVersion string `json:"resolvedInVersion,omitempty"`
	Note              string `json:"note,omitempty"`
}

var validTriageActions = map[string]bool{"resolve": true, "ignore": true, "unresolve": true, "assign": true}

// handleTriageAction — POST /services/{namespace}/{service}/triage/{fingerprint}
func (a *App) handleTriageAction(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	ctx := a.requestContext(req)
	namespace, service := parseServiceRef(req)
	if !requireServiceParam(w, service) {
		return
	}
	fingerprint := req.PathValue("fingerprint")
	if !fingerprintRe.MatchString(fingerprint) {
		http.Error(w, `{"error":"invalid fingerprint"}`, http.StatusBadRequest)
		return
	}
	var body triageActionRequest
	if err := json.NewDecoder(io.LimitReader(req.Body, 16<<10)).Decode(&body); err != nil || !validTriageActions[body.Action] {
		http.Error(w, `{"error":"invalid action"}`, http.StatusBadRequest)
		return
	}

	store := a.triageStore(ctx)
	a.warnOnBoundedAnnotationRetention(ctx, store)

	ev := TriageEvent{
		Action:            body.Action,
		Actor:             triageActor(ctx, req),
		Assignee:          body.Assignee,
		ResolvedInVersion: body.ResolvedInVersion,
		Note:              body.Note,
	}
	if err := store.Record(ctx, namespace, service, fingerprint, ev); err != nil {
		log.DefaultLogger.Warn("Triage write failed", "error", err)
		http.Error(w, `{"error":"recording triage action failed"}`, http.StatusBadGateway)
		return
	}

	// Return the new folded state so the UI can update without a refetch.
	states, err := store.States(ctx, namespace, service)
	if err != nil {
		writeJSON(w, TriageState{Status: "active"})
		return
	}
	writeJSON(w, states[fingerprint])
}

// handleTriageHistory — GET /services/{namespace}/{service}/triage/{fingerprint}/history
func (a *App) handleTriageHistory(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	namespace, service := parseServiceRef(req)
	if !requireServiceParam(w, service) {
		return
	}
	fingerprint := req.PathValue("fingerprint")
	if !fingerprintRe.MatchString(fingerprint) {
		http.Error(w, `{"error":"invalid fingerprint"}`, http.StatusBadRequest)
		return
	}
	events, err := a.triageStore(ctx).History(ctx, namespace, service, fingerprint)
	if err != nil {
		http.Error(w, `{"error":"reading triage history failed"}`, http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]any{"events": events})
}

// triageActor resolves who performed the action: the signed-in Grafana user
// from the plugin request context, falling back to headers, then "unknown".
// Every state change records its actor (Sentry model — anyone with plugin
// access may triage, but always attributably).
func triageActor(ctx context.Context, req *http.Request) string {
	if u := backend.UserFromContext(ctx); u != nil && u.Login != "" {
		return u.Login
	}
	if login := req.Header.Get("X-Grafana-User"); login != "" {
		return login
	}
	return "unknown"
}

var retentionWarnOnce sync.Once

// warnOnBoundedAnnotationRetention warns loudly (once per plugin process) if
// Grafana is configured to clean up API annotations — that setting would
// silently delete triage history. Requires admin scope; degrades silently.
func (a *App) warnOnBoundedAnnotationRetention(ctx context.Context, store *annotationTriageStore) {
	retentionWarnOnce.Do(func() {
		resp, err := store.do(ctx, http.MethodGet, "/api/admin/settings", nil)
		if err != nil {
			return
		}
		defer resp.Body.Close() //nolint:errcheck
		if resp.StatusCode != http.StatusOK {
			return // non-admin service account — cannot verify, stay quiet
		}
		var settings map[string]map[string]string
		if err := json.NewDecoder(io.LimitReader(resp.Body, 5<<20)).Decode(&settings); err != nil {
			return
		}
		api := settings["annotations.api"]
		if api["max_age"] != "" && api["max_age"] != "0" || api["max_annotations_to_keep"] != "" && api["max_annotations_to_keep"] != "0" {
			log.DefaultLogger.Warn("Grafana [annotations.api] retention is bounded — triage history WILL be deleted; set max_age and max_annotations_to_keep to 0 (see docs/triage.md)",
				"max_age", api["max_age"], "max_annotations_to_keep", api["max_annotations_to_keep"])
		}
	})
}

func truncateStr(s string) string {
	const n = 256
	if len(s) <= n {
		return s
	}
	return s[:n]
}
