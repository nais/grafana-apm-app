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
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// Response cap: versions are sorted by session count, and long-lived apps
// accumulate a long tail of stragglers on stale tabs — cap the payload.
const maxVersions = 20

// Deploy annotations are tagged per the #64 Phase 0 contract:
// nais-apm:deploy + service:<app> (+ env:<env>) + version:<sha>.
const (
	deployAnnotationTag = "nais-apm:deploy"
	versionTagPrefix    = "version:"
)

// VersionStat is per-app_version release health (#64 Phase 1), computed
// query-time from Faro streams in Loki — no plugin state.
type VersionStat struct {
	Version string `json:"version"`
	// Distinct sessions observed on this version in range.
	Sessions float64 `json:"sessions"`
	// Adoption is this version's share of all sessions in range (0..1).
	Adoption float64 `json:"adoption"`
	// ErrorFreeRate is 1 - (sessions with >=1 exception / sessions), 0..1.
	// 0 when the version has no sessions (e.g. exceptions arrived without
	// session context) — the UI treats that as "unknown", not "0% healthy".
	ErrorFreeRate float64 `json:"errorFreeRate"`
	// Exception occurrences on this version in range.
	Exceptions float64 `json:"exceptions"`
	// DeployedAtMs is the deploy annotation timestamp for this version,
	// when a matching nais-apm:deploy annotation exists in range.
	DeployedAtMs int64 `json:"deployedAtMs,omitempty"`
}

// FrontendVersionsResponse is the /frontend/versions payload.
type FrontendVersionsResponse struct {
	Versions []VersionStat `json:"versions"`
	// LatestVersion is the version tag on the newest deploy annotation in range.
	LatestVersion string `json:"latestVersion,omitempty"`
	// Unavailable indicates Loki is not configured/reachable for this env.
	Unavailable bool `json:"unavailable,omitempty"`
}

// handleFrontendVersions returns per-app_version release health stats.
// GET /services/{namespace}/{service}/frontend/versions?from=&to=&environment=
func (a *App) handleFrontendVersions(w http.ResponseWriter, req *http.Request) {
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

	lokiURL := a.lokiURL(env)
	if lokiURL == "" {
		writeJSON(w, FrontendVersionsResponse{Versions: []VersionStat{}, Unavailable: true})
		return
	}

	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("frontendversions", orgID, namespace, service, env, roundedUnix(from), roundedUnix(to))
	lokiClient := queries.NewLokiMetricClient(lokiURL, a.resolveServiceToken(ctx)).WithAuthHeaders(req.Header)

	a.writeCached(w, ck, "querying frontend versions failed", func() (any, error) {
		return a.queryFrontendVersions(ctx, lokiClient, service, env, from, to), nil
	})
}

func (a *App) queryFrontendVersions(ctx context.Context, loki *queries.PrometheusClient, service, env string, from, to time.Time) FrontendVersionsResponse {
	logger := log.DefaultLogger.With("handler", "frontend-versions")
	fl := a.otelCfg.FaroLoki
	allStream := a.otelCfg.LokiStreamSelector(service, "", env)
	excStream := a.otelCfg.LokiStreamSelector(service, fl.KindException, env)
	window := lokiWindow(from, to)

	// Distinct sessions per version: count_over_time keyed by
	// (app_version, session_id) yields one series per pair; counting series
	// per app_version = distinct sessions on that version.
	sessionsExpr := fmt.Sprintf(
		`count by (%[1]s) (count_over_time(%[2]s | logfmt | %[1]s!="" | %[3]s!="" | keep %[1]s, %[3]s %[4]s))`,
		fl.AppVersion, allStream, fl.SessionID, window,
	)
	// Distinct sessions with >=1 exception per version: same shape over the
	// exception stream only.
	errSessionsExpr := fmt.Sprintf(
		`count by (%[1]s) (count_over_time(%[2]s | logfmt | %[1]s!="" | %[3]s!="" | keep %[1]s, %[3]s %[4]s))`,
		fl.AppVersion, excStream, fl.SessionID, window,
	)
	// Exception occurrences per version.
	exceptionsExpr := fmt.Sprintf(
		`sum by (%[1]s) (count_over_time(%[2]s | logfmt | %[1]s!="" | keep %[1]s %[3]s))`,
		fl.AppVersion, excStream, window,
	)

	var (
		wg                          sync.WaitGroup
		sessRes, errSessRes, excRes []queries.PromResult
		sessErr, errSessErr, excErr error
		deploys                     map[string]int64
		latestVersion               string
	)
	wg.Add(4)
	go func() { defer wg.Done(); sessRes, sessErr = loki.InstantQuery(ctx, sessionsExpr, to) }()
	go func() { defer wg.Done(); errSessRes, errSessErr = loki.InstantQuery(ctx, errSessionsExpr, to) }()
	go func() { defer wg.Done(); excRes, excErr = loki.InstantQuery(ctx, exceptionsExpr, to) }()
	go func() {
		defer wg.Done()
		deploys, latestVersion = a.fetchDeployAnnotations(ctx, service, env, from, to)
	}()
	wg.Wait()
	if sessErr != nil {
		logger.Warn("Version sessions query failed", "error", sessErr)
		return FrontendVersionsResponse{Versions: []VersionStat{}, Unavailable: true}
	}
	if errSessErr != nil {
		logger.Debug("Version error-sessions query failed", "error", errSessErr)
	}
	if excErr != nil {
		logger.Debug("Version exceptions query failed", "error", excErr)
	}

	stats := make(map[string]*VersionStat)
	stat := func(version string) *VersionStat {
		s, ok := stats[version]
		if !ok {
			s = &VersionStat{Version: version}
			stats[version] = s
		}
		return s
	}

	var totalSessions float64
	for _, r := range sessRes {
		if v := r.Metric[fl.AppVersion]; v != "" {
			stat(v).Sessions += r.Value.Float()
			totalSessions += r.Value.Float()
		}
	}
	errSessions := make(map[string]float64, len(errSessRes))
	for _, r := range errSessRes {
		if v := r.Metric[fl.AppVersion]; v != "" {
			errSessions[v] += r.Value.Float()
		}
	}
	// Exceptions can reference versions with no session-carrying streams in
	// range (e.g. sampled-out sessions) — still surface those versions.
	for _, r := range excRes {
		if v := r.Metric[fl.AppVersion]; v != "" {
			stat(v).Exceptions += r.Value.Float()
		}
	}

	out := make([]VersionStat, 0, len(stats))
	for _, s := range stats {
		if totalSessions > 0 {
			s.Adoption = roundTo(s.Sessions/totalSessions, 4)
		}
		if s.Sessions > 0 {
			s.ErrorFreeRate = roundTo(1-min(errSessions[s.Version]/s.Sessions, 1), 4)
		}
		if t, ok := deploys[s.Version]; ok {
			s.DeployedAtMs = t
		}
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Sessions != out[j].Sessions {
			return out[i].Sessions > out[j].Sessions
		}
		return out[i].Version < out[j].Version
	})
	if len(out) > maxVersions {
		out = out[:maxVersions]
	}

	return FrontendVersionsResponse{Versions: out, LatestVersion: latestVersion}
}

// grafanaAnnotation is the subset of Grafana's annotation payload we consume
// (deploy markers here; the triage event log in triage.go).
type grafanaAnnotation struct {
	ID   int64    `json:"id"`
	Time int64    `json:"time"` // epoch ms
	Text string   `json:"text"`
	Tags []string `json:"tags"`
}

// fetchDeployAnnotations queries the Grafana annotations API for deploy
// markers (#64 Phase 0 contract) and returns version → deploy timestamp (ms)
// plus the version on the newest deploy. Degrades gracefully: any failure
// returns empty enrichment — version stats render without deploy times.
func (a *App) fetchDeployAnnotations(ctx context.Context, service, env string, from, to time.Time) (map[string]int64, string) {
	if a.healthClient == nil || a.grafanaURL == "" {
		return nil, ""
	}
	logger := log.DefaultLogger.With("handler", "frontend-versions")

	params := url.Values{}
	params.Add("tags", deployAnnotationTag)
	params.Add("tags", "service:"+service)
	// Repeated tags params AND together; a multi-env selection can't be
	// expressed that way, so only scope when a single environment is selected.
	if env != "" && !strings.Contains(env, ",") {
		params.Add("tags", "env:"+env)
	}
	params.Set("from", strconv.FormatInt(from.UnixMilli(), 10))
	params.Set("to", strconv.FormatInt(to.UnixMilli(), 10))
	params.Set("limit", "100")

	apiReq, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/api/annotations?%s", a.grafanaURL, params.Encode()), nil)
	if err != nil {
		return nil, ""
	}
	if token := a.resolveServiceToken(ctx); token != "" {
		apiReq.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := a.healthClient.Do(apiReq)
	if err != nil {
		logger.Debug("Deploy annotations request failed", "error", err)
		return nil, ""
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		logger.Debug("Deploy annotations request failed", "status", resp.StatusCode)
		return nil, ""
	}

	var annotations []grafanaAnnotation
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&annotations); err != nil {
		logger.Debug("Deploy annotations decode failed", "error", err)
		return nil, ""
	}

	deploys := make(map[string]int64, len(annotations))
	var latestVersion string
	var latestTime int64
	for _, ann := range annotations {
		version := ""
		for _, tag := range ann.Tags {
			if v, ok := strings.CutPrefix(tag, versionTagPrefix); ok && v != "" {
				version = v
				break
			}
		}
		if version == "" {
			continue
		}
		// A version can deploy more than once (multi-env, re-deploys) —
		// keep the earliest marker as "when this release landed".
		if t, ok := deploys[version]; !ok || ann.Time < t {
			deploys[version] = ann.Time
		}
		if ann.Time > latestTime {
			latestTime = ann.Time
			latestVersion = version
		}
	}
	return deploys, latestVersion
}
