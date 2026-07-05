package plugin

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/fingerprint"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// Member hashes are used by the drawer as an =~ regex over the hash field —
// cap the list so pathological groups can't produce unbounded regexes (#62).
const maxMemberHashes = 50

// Response cap: groups are sorted by occurrence count, and noisy apps produce
// hundreds of long-tail groups nobody pages through — cap the payload.
const maxGroups = 100

// ExceptionGroup is one fingerprint-keyed issue group (#62 Phase 0):
// upstream Alloy hash groups (xxh3 of the raw message) merged by the
// versioned fingerprint so dynamic message content doesn't splinter issues.
type ExceptionGroup struct {
	Fingerprint string `json:"fingerprint"`
	Tier        int    `json:"tier"`
	Title       string `json:"title"`
	// Types observed in the group (usually one; more after tier-3 merges).
	Types []string `json:"types,omitempty"`
	// Count of occurrences in range (sum over member hashes).
	Count float64 `json:"count"`
	// Sessions affected. Summed per member hash — a session hitting two
	// member hashes counts twice; acceptable for ranking.
	Sessions float64 `json:"sessions"`
	// MemberHashes are the upstream Alloy hashes merged into this group,
	// capped at maxMemberHashes (Truncated set when the cap hit).
	MemberHashes []string `json:"memberHashes"`
	Truncated    bool     `json:"truncated,omitempty"`
}

// ExceptionGroupsResponse is the /exceptions/groups payload.
type ExceptionGroupsResponse struct {
	FingerprintVersion string           `json:"fingerprintVersion"`
	Groups             []ExceptionGroup `json:"groups"`
	// Unavailable indicates Loki is not configured/reachable for this env.
	Unavailable bool `json:"unavailable,omitempty"`
	// SessionsWindowSeconds is set when the distinct-session counts had to be
	// computed over a narrower window than the requested range: the
	// (hash × session_id) series set exceeds Loki's max_query_series on wide
	// ranges for chatty apps, so we fall back to the most recent hour.
	SessionsWindowSeconds int `json:"sessionsWindowSeconds,omitempty"`
	// SessionsUnavailable is set when even the fallback sessions query failed
	// — the UI shows an em dash instead of a misleading 0.
	SessionsUnavailable bool `json:"sessionsUnavailable,omitempty"`
}

// handleExceptionGroups returns fingerprint-grouped frontend exceptions.
// GET /services/{namespace}/{service}/exceptions/groups?from=&to=&environment=
func (a *App) handleExceptionGroups(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	namespace, service := parseServiceRef(req)
	env := parseEnvironment(req)
	if !requireServiceParam(w, service) {
		return
	}

	now := time.Now()
	from := parseUnixParam(req, "from", now.Add(-1*time.Hour))
	to := parseUnixParam(req, "to", now)

	lokiUID := a.settings.LogsDataSource.Resolve(env).UID
	if lokiUID == "" {
		writeJSON(w, ExceptionGroupsResponse{FingerprintVersion: fingerprint.Version, Groups: []ExceptionGroup{}, Unavailable: true})
		return
	}

	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("exceptiongroups", orgID, namespace, service, env, roundedUnix(from), roundedUnix(to))

	// Queries go through Grafana's datasource query API (/api/ds/query) —
	// the sanctioned, non-deprecated path — rather than the datasource proxy.
	dsClient := queries.NewDsQueryClient(a.grafanaURL, a.resolveServiceToken(ctx)).WithAuthHeaders(req.Header)

	a.writeCached(w, ck, "querying exception groups failed", func() (any, error) {
		return a.queryExceptionGroups(ctx, dsClient, lokiUID, service, env, from, to), nil
	})
}

// sessionsFallbackWindows is the retry ladder when the full-range
// distinct-sessions query exceeds Loki's max_query_series (hash × session_id
// cardinality): recent-window counts are a cheap, honest approximation for
// ranking. The 10m rung covers apps chatty enough to blow the limit within
// an hour (observed: >150k occurrences/day on a single group; the same app
// exceeded the limit within 10 minutes at peak).
var sessionsFallbackWindows = []time.Duration{time.Hour, 15 * time.Minute, 5 * time.Minute, time.Minute}

func (a *App) queryExceptionGroups(ctx context.Context, ds *queries.DsQueryClient, lokiUID, service, env string, from, to time.Time) ExceptionGroupsResponse {
	logger := log.DefaultLogger.With("handler", "exception-groups")
	fl := a.otelCfg.FaroLoki
	stream := a.otelCfg.LokiStreamSelector(service, fl.KindException, env)
	window := lokiWindow(from, to)

	// Counts per upstream (hash, type, value): type joins the group-by versus
	// the UI's historical (hash, value) so the fingerprint can use tier 2.
	countExpr := fmt.Sprintf(
		`sum by (%[1]s, %[2]s, value) (count_over_time(%[3]s | logfmt | %[1]s!="" | keep %[1]s, %[2]s, value %[4]s))`,
		fl.Hash, fl.TypeField, stream, window,
	)
	// Distinct sessions per (hash): dedupe by (hash, session_id), then count.
	sessionsExpr := func(w string) string {
		return fmt.Sprintf(
			`count by (%[1]s) (count_over_time(%[2]s | logfmt | %[1]s!="" | %[3]s!="" | keep %[1]s, %[3]s %[4]s))`,
			fl.Hash, stream, fl.SessionID, w,
		)
	}

	var (
		wg                sync.WaitGroup
		countRes, sessRes []queries.PromResult
		countErr, sessErr error
		sessWindowSecs    int
	)
	wg.Add(2)
	go func() { defer wg.Done(); countRes, countErr = ds.InstantQuery(ctx, lokiUID, countExpr, to) }()
	go func() {
		defer wg.Done()
		sessRes, sessErr = ds.InstantQuery(ctx, lokiUID, sessionsExpr(window), to)
		for _, w := range sessionsFallbackWindows {
			if sessErr == nil {
				break
			}
			// Skip rungs that aren't narrower than the requested range — but keep
			// descending the ladder (a 30m request can still succeed at 15m/5m/1m).
			if to.Sub(from) <= w {
				continue
			}
			// Wide ranges blow Loki's series limit — retry over a recent window.
			sessRes, sessErr = ds.InstantQuery(ctx, lokiUID, sessionsExpr(lokiWindow(to.Add(-w), to)), to)
			if sessErr == nil {
				sessWindowSecs = int(w.Seconds())
			}
		}
	}()
	wg.Wait()
	if countErr != nil {
		logger.Warn("Exception count query failed", "error", countErr)
		return ExceptionGroupsResponse{FingerprintVersion: fingerprint.Version, Groups: []ExceptionGroup{}, Unavailable: true}
	}
	if sessErr != nil {
		logger.Warn("Exception sessions query failed", "error", sessErr)
	}

	sessionsByHash := make(map[string]float64, len(sessRes))
	for _, r := range sessRes {
		sessionsByHash[r.Metric[fl.Hash]] += safeFloat(r.Value.Float())
	}

	groups := make(map[string]*ExceptionGroup)
	seenHash := make(map[string]map[string]bool) // fingerprint -> member hash set
	seenType := make(map[string]map[string]bool) // fingerprint -> type set
	for _, r := range countRes {
		hash := r.Metric[fl.Hash]
		exType := r.Metric[fl.TypeField]
		value := r.Metric["value"]
		fp := fingerprint.Compute(fingerprint.Event{Type: exType, Value: value, UpstreamHash: hash})

		g, ok := groups[fp.Value]
		if !ok {
			g = &ExceptionGroup{Fingerprint: fp.Value, Tier: int(fp.Tier), Title: fp.Title}
			groups[fp.Value] = g
			seenHash[fp.Value] = make(map[string]bool)
			seenType[fp.Value] = make(map[string]bool)
		}
		g.Count += safeFloat(r.Value.Float())
		if hash != "" && !seenHash[fp.Value][hash] {
			seenHash[fp.Value][hash] = true
			if len(g.MemberHashes) < maxMemberHashes {
				g.MemberHashes = append(g.MemberHashes, hash)
			} else {
				g.Truncated = true
			}
			g.Sessions += sessionsByHash[hash]
		}
		if exType != "" && !seenType[fp.Value][exType] {
			seenType[fp.Value][exType] = true
			g.Types = append(g.Types, exType)
		}
	}

	out := make([]ExceptionGroup, 0, len(groups))
	for _, g := range groups {
		sort.Strings(g.Types)
		out = append(out, *g)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Fingerprint < out[j].Fingerprint
	})
	if len(out) > maxGroups {
		out = out[:maxGroups]
	}

	return ExceptionGroupsResponse{
		FingerprintVersion:    fingerprint.Version,
		Groups:                out,
		SessionsWindowSeconds: sessWindowSecs,
		SessionsUnavailable:   sessErr != nil,
	}
}

// lokiWindow formats a LogQL range window covering [from, to].
func lokiWindow(from, to time.Time) string {
	d := max(to.Sub(from), time.Minute)
	return fmt.Sprintf("[%ds]", int(d.Seconds()))
}
