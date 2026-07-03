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

	lokiURL := a.lokiURL(env)
	if lokiURL == "" {
		writeJSON(w, ExceptionGroupsResponse{FingerprintVersion: fingerprint.Version, Groups: []ExceptionGroup{}, Unavailable: true})
		return
	}

	orgID := req.Header.Get("X-Grafana-Org-Id")
	roundedFrom := fmt.Sprintf("%d", from.Unix()/30*30)
	roundedTo := fmt.Sprintf("%d", to.Unix()/30*30)
	ck := cacheKey("exceptiongroups", orgID, namespace, service, env, roundedFrom, roundedTo)
	if cached, ok := a.respCache.get(ck); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Cache", "HIT")
		_, _ = w.Write(cached)
		return
	}

	lokiClient := queries.NewLokiMetricClient(lokiURL, a.resolveServiceToken(ctx)).WithAuthHeaders(req.Header)

	data, err := a.respCache.getOrCompute(ck, func() (any, error) {
		return a.queryExceptionGroups(ctx, lokiClient, service, env, from, to), nil
	})
	if err != nil {
		http.Error(w, "querying exception groups failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}

func (a *App) queryExceptionGroups(ctx context.Context, loki *queries.PrometheusClient, service, env string, from, to time.Time) ExceptionGroupsResponse {
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
	sessionsExpr := fmt.Sprintf(
		`count by (%[1]s) (count_over_time(%[2]s | logfmt | %[1]s!="" | %[3]s!="" | keep %[1]s, %[3]s %[4]s))`,
		fl.Hash, stream, fl.SessionID, window,
	)

	var (
		wg                sync.WaitGroup
		countRes, sessRes []queries.PromResult
		countErr, sessErr error
	)
	wg.Go(func() { countRes, countErr = loki.InstantQuery(ctx, countExpr, to) })
	wg.Go(func() { sessRes, sessErr = loki.InstantQuery(ctx, sessionsExpr, to) })
	wg.Wait()
	if countErr != nil {
		logger.Warn("Exception count query failed", "error", countErr)
		return ExceptionGroupsResponse{FingerprintVersion: fingerprint.Version, Groups: []ExceptionGroup{}, Unavailable: true}
	}
	if sessErr != nil {
		logger.Debug("Exception sessions query failed", "error", sessErr)
	}

	sessionsByHash := make(map[string]float64, len(sessRes))
	for _, r := range sessRes {
		sessionsByHash[r.Metric[fl.Hash]] += r.Value.Float()
	}

	groups := make(map[string]*ExceptionGroup)
	seenHash := make(map[string]map[string]bool)  // fingerprint -> member hash set
	seenType := make(map[string]map[string]bool)  // fingerprint -> type set
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
		g.Count += r.Value.Float()
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

	return ExceptionGroupsResponse{FingerprintVersion: fingerprint.Version, Groups: out}
}

// lokiWindow formats a LogQL range window covering [from, to].
func lokiWindow(from, to time.Time) string {
	d := max(to.Sub(from), time.Minute)
	return fmt.Sprintf("[%ds]", int(d.Seconds()))
}
