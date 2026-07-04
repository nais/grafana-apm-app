package plugin

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/fingerprint"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// Distinct expr substrings per query (mockDsQueryServer matches keys against
// the posted expr, so keys must be mutually exclusive):
//
//	browser counts   → "sum by (hash"
//	browser sessions → "count by (hash"
//	server shape a   → "sum by (exception_type, exception_message) ("
//	shape a impact   → "sum by (exception_type, exception_message, k8s_pod_name)"
//	server shape b   → "sum by (message, msg) ("
//	shape b impact   → "sum by (message, msg, k8s_pod_name)"
//	shape c count    → "sum(count_over_time("
//	shape c sample   → "drop __error__" (range/log query, served from logsMap)

func TestQueryIssuesMergesBrowserAndServer(t *testing.T) {
	browserCounts := []queries.PromResult{
		{Metric: map[string]string{"hash": "111", "type": "TypeError", "value": "t.map is not a function"}, Value: queries.NewPromValue(0, "10")},
	}
	browserSessions := []queries.PromResult{
		{Metric: map[string]string{"hash": "111"}, Value: queries.NewPromValue(0, "4")},
	}
	serverCounts := []queries.PromResult{
		{Metric: map[string]string{"exception_type": "PSQLException", "exception_message": "connection to 10.0.0.1 refused"}, Value: queries.NewPromValue(0, "40")},
	}
	serverPods := []queries.PromResult{
		{Metric: map[string]string{"exception_type": "PSQLException", "exception_message": "connection to 10.0.0.1 refused", "k8s_pod_name": "app-a"}, Value: queries.NewPromValue(0, "25")},
		{Metric: map[string]string{"exception_type": "PSQLException", "exception_message": "connection to 10.0.0.1 refused", "k8s_pod_name": "app-b"}, Value: queries.NewPromValue(0, "15")},
	}
	app, ds := exceptionsTestApp(t, map[string][]queries.PromResult{
		"sum by (hash":   browserCounts,
		"count by (hash": browserSessions,
		"sum by (exception_type, exception_message) (":             serverCounts,
		"sum by (exception_type, exception_message, k8s_pod_name)": serverPods,
	}, nil)

	resp := app.queryIssues(context.Background(), ds, "loki-uid", "my-app", "prod-gcp", time.Unix(1000, 0), time.Unix(4600, 0), browserFacets{})

	if resp.FingerprintVersion != fingerprint.Version {
		t.Errorf("fingerprintVersion = %q", resp.FingerprintVersion)
	}
	if !resp.Sources.Browser || !resp.Sources.ServerLogs {
		t.Errorf("sources = %+v, want both true", resp.Sources)
	}
	if resp.Unavailable {
		t.Error("unexpected unavailable")
	}
	if len(resp.Issues) != 2 {
		t.Fatalf("expected 2 issues, got %d: %+v", len(resp.Issues), resp.Issues)
	}

	srv := resp.Issues[0] // sorted by count desc → server issue (40) first
	if srv.Source != issueSourceServer {
		t.Errorf("issues[0].source = %q, want server", srv.Source)
	}
	if srv.Count != 40 {
		t.Errorf("server count = %v, want 40", srv.Count)
	}
	if srv.Title != "PSQLException: connection to <ip> refused" {
		t.Errorf("server title = %q", srv.Title)
	}
	if srv.Tier != int(fingerprint.TierTypeMessage) {
		t.Errorf("server tier = %d", srv.Tier)
	}
	if len(srv.Types) != 1 || srv.Types[0] != "PSQLException" {
		t.Errorf("server types = %v", srv.Types)
	}
	if len(srv.MemberHashes) != 0 {
		t.Errorf("server memberHashes = %v, want empty (no Alloy hash)", srv.MemberHashes)
	}
	if srv.Impact == nil || srv.Impact.Pods != 2 {
		t.Errorf("server impact = %+v, want 2 pods", srv.Impact)
	}

	br := resp.Issues[1]
	if br.Source != issueSourceBrowser {
		t.Errorf("issues[1].source = %q, want browser", br.Source)
	}
	if br.Count != 10 || br.Sessions != 4 {
		t.Errorf("browser issue = %+v", br.ExceptionGroup)
	}
	if br.Impact != nil {
		t.Errorf("browser impact = %+v, want nil", br.Impact)
	}
}

func TestQueryServerExceptionGroupsJSONShape(t *testing.T) {
	// Shape (b) only: messages differing by a UUID merge into one tier-3
	// group; rows with an empty message are dropped, not grouped.
	counts := []queries.PromResult{
		{Metric: map[string]string{"message": "Invalid søknad 8f3a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8"}, Value: queries.NewPromValue(0, "7")},
		{Metric: map[string]string{"message": "Invalid søknad 91bb0000-1111-2222-3333-444455556666"}, Value: queries.NewPromValue(0, "3")},
		{Metric: map[string]string{"message": ""}, Value: queries.NewPromValue(0, "5")},
	}
	pods := []queries.PromResult{
		{Metric: map[string]string{"message": "Invalid søknad 8f3a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8", "k8s_pod_name": "app-a"}, Value: queries.NewPromValue(0, "7")},
		{Metric: map[string]string{"message": "Invalid søknad 91bb0000-1111-2222-3333-444455556666", "k8s_pod_name": "app-b"}, Value: queries.NewPromValue(0, "3")},
	}
	app, ds := exceptionsTestApp(t, map[string][]queries.PromResult{
		"sum by (message, msg) (":             counts,
		"sum by (message, msg, k8s_pod_name)": pods,
	}, nil)

	issues, ok := app.queryServerExceptionGroups(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0))

	if !ok {
		t.Fatal("expected server side to be available")
	}
	if len(issues) != 1 {
		t.Fatalf("expected 1 group, got %d: %+v", len(issues), issues)
	}
	g := issues[0]
	if g.Count != 10 {
		t.Errorf("count = %v, want 10", g.Count)
	}
	if g.Tier != int(fingerprint.TierMessage) {
		t.Errorf("tier = %d, want %d", g.Tier, fingerprint.TierMessage)
	}
	if g.Title != "Invalid søknad <uuid>" {
		t.Errorf("title = %q", g.Title)
	}
	if g.Impact == nil || g.Impact.Pods != 2 {
		t.Errorf("impact = %+v, want 2 pods", g.Impact)
	}
	if g.Source != issueSourceServer {
		t.Errorf("source = %q", g.Source)
	}
}

func TestQueryIssuesServerErrorDegradesGracefully(t *testing.T) {
	// All three server shape count queries fail (e.g. Loki series limit) —
	// the endpoint still returns the browser issues and flags serverLogs=false.
	browserCounts := []queries.PromResult{
		{Metric: map[string]string{"hash": "111", "type": "Error", "value": "boom"}, Value: queries.NewPromValue(0, "10")},
	}
	app, ds := exceptionsTestApp(t,
		map[string][]queries.PromResult{"sum by (hash": browserCounts},
		map[string]string{
			`exception_type != ""`:       "maximum number of series (5000) reached for a single query",
			`message != "" or msg != ""`: "maximum number of series (5000) reached for a single query",
			`sum(count_over_time(`:       "maximum number of series (5000) reached for a single query",
		})

	resp := app.queryIssues(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0), browserFacets{})

	if resp.Sources.ServerLogs {
		t.Error("sources.serverLogs should be false when both shape queries fail")
	}
	if !resp.Sources.Browser {
		t.Error("sources.browser should remain true")
	}
	if resp.Unavailable {
		t.Error("one-sided failure must not mark the whole response unavailable")
	}
	if len(resp.Issues) != 1 || resp.Issues[0].Source != issueSourceBrowser {
		t.Fatalf("expected the browser issue to survive, got %+v", resp.Issues)
	}
}

func TestQueryIssuesBrowserErrorDegradesGracefully(t *testing.T) {
	// The Faro count query fails — server issues are still returned and only
	// sources.browser flips to false.
	serverCounts := []queries.PromResult{
		{Metric: map[string]string{"exception_type": "KafkaTimeoutException", "exception_message": "timed out"}, Value: queries.NewPromValue(0, "12")},
	}
	app, ds := exceptionsTestApp(t,
		map[string][]queries.PromResult{"sum by (exception_type, exception_message) (": serverCounts},
		map[string]string{"sum by (hash": "loki is down"})

	resp := app.queryIssues(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0), browserFacets{})

	if resp.Sources.Browser {
		t.Error("sources.browser should be false when the Faro query fails")
	}
	if !resp.Sources.ServerLogs {
		t.Error("sources.serverLogs should remain true")
	}
	if resp.Unavailable {
		t.Error("one-sided failure must not mark the whole response unavailable")
	}
	if len(resp.Issues) != 1 || resp.Issues[0].Source != issueSourceServer {
		t.Fatalf("expected the server issue to survive, got %+v", resp.Issues)
	}
	if resp.Issues[0].Impact == nil || resp.Issues[0].Impact.Pods != 0 {
		t.Errorf("impact = %+v, want pods 0 (no pod rows returned)", resp.Issues[0].Impact)
	}
}

func TestQueryServerExceptionGroupsMsgFieldShape(t *testing.T) {
	// Shape (b) with slog/pino-default field naming: the body message arrives
	// in `msg` and `message` is empty (surveyed live: dbt-docs, the
	// nav-enonicxp-frontend revalidator proxies). The msg value must be used
	// for fingerprinting instead of dropping the row.
	counts := []queries.PromResult{
		{Metric: map[string]string{"message": "", "msg": "revalidation request failed for path /some/path: status 502"}, Value: queries.NewPromValue(0, "8")},
		{Metric: map[string]string{"message": "Fetching varsler failed. Http error with status: 500", "msg": ""}, Value: queries.NewPromValue(0, "20")},
	}
	app, ds := exceptionsTestApp(t, map[string][]queries.PromResult{
		"sum by (message, msg) (": counts,
	}, nil)

	issues, ok := app.queryServerExceptionGroups(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0))

	if !ok {
		t.Fatal("expected server side to be available")
	}
	if len(issues) != 2 {
		t.Fatalf("expected 2 groups, got %d: %+v", len(issues), issues)
	}
	titles := map[string]float64{}
	for _, g := range issues {
		titles[g.Title] = g.Count
	}
	if titles["revalidation request failed for path /some/path: status 502"] != 8 {
		t.Errorf("msg-field group missing or wrong count: %+v", titles)
	}
	if titles["Fetching varsler failed. Http error with status: 500"] != 20 {
		t.Errorf("message-field group missing or wrong count: %+v", titles)
	}
}

// Real error line shapes sampled from NAV production Loki (2026-07-04),
// scrubbed of ids. navno-search-frontend logs unstructured plain text —
// neither shape (a) nor (b) can title it; only the shape (c) sample can.
const (
	plainLineSearch = `Error: Failed to fetch search results from "https://navno-search-api.nav.no/content/search?ord=&page=0" - Error: Internal Server Error`
	plainLineProxy  = `2026/07/04 07:30:33 proxy server error: accept tcp 127.0.0.1:5432: use of closed network connection`
	// Real logback status-printer lines (2026-07, scrubbed): the config prints
	// these on startup and detected_level flags them as errors because they
	// mention "ERROR". They are boot noise, not application errors.
	bootstrapLineRoot   = `13:37:22,458 |-INFO in ch.qos.logback.classic.joran.action.RootLoggerAction - Setting level of ROOT logger to ERROR`
	bootstrapLineLogger = `13:37:22,459 |-WARN in ch.qos.logback.classic.model.processor.LoggerModelHandler - Setting level of logger [no.nav.scrubbed] to ERROR`
)

func TestQueryServerExceptionGroupsPlainTextShape(t *testing.T) {
	// Shape (c): the count query carries the total volume (12); the sampled
	// lines (4) carry the titles. Counts distribute proportionally over the
	// sampled fingerprints: 3-of-4 search errors → 9, 1-of-4 proxy errors → 3.
	plainCount := []queries.PromResult{
		{Metric: map[string]string{}, Value: queries.NewPromValue(0, "12")},
	}
	sample := []string{plainLineSearch, plainLineSearch, plainLineSearch, plainLineProxy}
	app, ds := exceptionsTestApp(t,
		map[string][]queries.PromResult{"sum(count_over_time(": plainCount},
		nil,
		map[string][]string{"drop __error__": sample})

	issues, ok := app.queryServerExceptionGroups(context.Background(), ds, "loki-uid", "navno-search-frontend", "", time.Unix(0, 0), time.Unix(3600, 0))

	if !ok {
		t.Fatal("expected server side to be available")
	}
	if len(issues) != 2 {
		t.Fatalf("expected 2 groups, got %d: %+v", len(issues), issues)
	}
	byCount := map[float64]Issue{}
	for _, g := range issues {
		byCount[g.Count] = g
	}
	search, okSearch := byCount[9]
	proxy, okProxy := byCount[3]
	if !okSearch || !okProxy {
		t.Fatalf("expected counts 9 and 3, got %+v", issues)
	}
	// The URL and the trailing dynamic tokens normalize into the title.
	if search.Title != `Error: Failed to fetch search results from "<url>" - Error: Internal Server Error` {
		t.Errorf("search title = %q", search.Title)
	}
	if proxy.Title == "" || proxy.Tier != int(fingerprint.TierMessage) {
		t.Errorf("proxy group = %+v", proxy)
	}
	for _, g := range issues {
		if g.Source != issueSourceServer {
			t.Errorf("source = %q, want server", g.Source)
		}
		if g.Impact == nil || g.Impact.Pods != 0 {
			t.Errorf("sampled plain-text impact = %+v, want pods 0", g.Impact)
		}
	}
}

func TestQueryServerExceptionGroupsFiltersBootstrapNoise(t *testing.T) {
	// Shape (c): Loki's detected_level mis-flags a logback bootstrap status
	// line as an error, so it rides alongside a real error line in the sample.
	// The boot line must be dropped from the titles and its volume must NOT be
	// reattributed to the real group: total 12, sample is 3 real + 1 noise, so
	// the counted volume scales to 12·3/4 = 9 and lands entirely on the real
	// group. The boot line never becomes its own count-1 issue.
	plainCount := []queries.PromResult{
		{Metric: map[string]string{}, Value: queries.NewPromValue(0, "12")},
	}
	sample := []string{plainLineSearch, plainLineSearch, plainLineSearch, bootstrapLineRoot}
	app, ds := exceptionsTestApp(t,
		map[string][]queries.PromResult{"sum(count_over_time(": plainCount},
		nil,
		map[string][]string{"drop __error__": sample})

	issues, ok := app.queryServerExceptionGroups(context.Background(), ds, "loki-uid", "navno-search-frontend", "", time.Unix(0, 0), time.Unix(3600, 0))

	if !ok {
		t.Fatal("expected server side to be available")
	}
	if len(issues) != 1 {
		t.Fatalf("expected 1 group (boot noise dropped), got %d: %+v", len(issues), issues)
	}
	g := issues[0]
	if g.Title != `Error: Failed to fetch search results from "<url>" - Error: Internal Server Error` {
		t.Errorf("title = %q, want the real error (not the logback banner)", g.Title)
	}
	if g.Count != 9 {
		t.Errorf("count = %v, want 9 (boot-noise volume discarded, not reattributed)", g.Count)
	}
}

func TestAddPlainTextGroupsAllBootstrapNoiseDropped(t *testing.T) {
	// Every sampled line is logback boot noise mis-flagged by detected_level.
	// The whole shape must contribute nothing — not even an "Unparsed error
	// logs" fallback — so a service that only logs its config never appears in
	// the issues list.
	plainRes := []queries.PromResult{
		{Metric: map[string]string{}, Value: queries.NewPromValue(0, "8")},
	}
	sample := []queries.LogEntry{{Line: bootstrapLineRoot}, {Line: bootstrapLineLogger}}

	emitted := 0
	addPlainTextGroups(plainRes, sample, func(_, _ string, _ float64) { emitted++ })
	if emitted != 0 {
		t.Errorf("emitted %d groups, want 0 (all sampled lines are boot noise)", emitted)
	}
}

func TestAddPlainTextGroupsCoercesNonFiniteVolume(t *testing.T) {
	// Defense-in-depth (#70 QA): a count row that parses to NaN/±Inf must not
	// poison the summed volume — an unguarded sum flows a non-finite Count into
	// the group and json.Marshal then 500s the endpoint. safeFloat coerces the
	// bad row to 0 so the distributed counts stay finite.
	plainRes := []queries.PromResult{
		{Metric: map[string]string{}, Value: queries.NewPromValue(0, "NaN")},
		{Metric: map[string]string{}, Value: queries.NewPromValue(0, "12")},
	}
	sample := []queries.LogEntry{{Line: "boom"}, {Line: "boom"}, {Line: "boom"}, {Line: "kapow"}}

	var total float64
	addPlainTextGroups(plainRes, sample, func(_, msg string, count float64) {
		if math.IsNaN(count) || math.IsInf(count, 0) {
			t.Errorf("group %q count = %v, want finite", msg, count)
		}
		total += count
	})
	// plainTotal = safeFloat(NaN) + 12 = 12, distributed 3:1 over the 4 lines.
	if total != 12 {
		t.Errorf("distributed total = %v, want 12 (NaN row coerced to 0)", total)
	}
}

func TestQueryServerExceptionGroupsPlainTextAllEmptyFallback(t *testing.T) {
	// Shape (c) edge: the count query proves error-level volume (12), but every
	// sampled line is whitespace-only and trims empty — nothing to fingerprint.
	// The volume must surface as one "Unparsed error logs" group instead of
	// silently vanishing.
	plainCount := []queries.PromResult{
		{Metric: map[string]string{}, Value: queries.NewPromValue(0, "12")},
	}
	sample := []string{"   ", "\t\n", "", "  \t "}
	app, ds := exceptionsTestApp(t,
		map[string][]queries.PromResult{"sum(count_over_time(": plainCount},
		nil,
		map[string][]string{"drop __error__": sample})

	issues, ok := app.queryServerExceptionGroups(context.Background(), ds, "loki-uid", "navno-search-frontend", "", time.Unix(0, 0), time.Unix(3600, 0))

	if !ok {
		t.Fatal("expected server side to be available")
	}
	if len(issues) != 1 {
		t.Fatalf("expected 1 fallback group, got %d: %+v", len(issues), issues)
	}
	g := issues[0]
	if g.Title != unparsedPlainTextTitle {
		t.Errorf("fallback title = %q, want %q", g.Title, unparsedPlainTextTitle)
	}
	if g.Count != 12 {
		t.Errorf("fallback count = %v, want 12 (full counted volume)", g.Count)
	}
	if g.Source != issueSourceServer {
		t.Errorf("source = %q, want server", g.Source)
	}
	if g.Impact == nil || g.Impact.Pods != 0 {
		t.Errorf("fallback impact = %+v, want pods 0", g.Impact)
	}
}

func TestQueryIssueFacets(t *testing.T) {
	// Facet-value discovery: topk(sum by (field)) rows fold into count-sorted,
	// empty-dropped facet lists.
	versions := []queries.PromResult{
		{Metric: map[string]string{"app_version": "1.2.0"}, Value: queries.NewPromValue(0, "50")},
		{Metric: map[string]string{"app_version": "1.3.0"}, Value: queries.NewPromValue(0, "120")},
		{Metric: map[string]string{"app_version": ""}, Value: queries.NewPromValue(0, "9")}, // empty → dropped
	}
	browsers := []queries.PromResult{
		{Metric: map[string]string{"browser_name": "Chrome"}, Value: queries.NewPromValue(0, "200")},
		{Metric: map[string]string{"browser_name": "Safari"}, Value: queries.NewPromValue(0, "40")},
	}
	pages := []queries.PromResult{
		{Metric: map[string]string{"page_url": "https://tms-min-side.nav.no/"}, Value: queries.NewPromValue(0, "77")},
	}
	app, ds := exceptionsTestApp(t, map[string][]queries.PromResult{
		"sum by (app_version)":  versions,
		"sum by (browser_name)": browsers,
		"sum by (page_url)":     pages,
	}, nil)

	facets := app.queryIssueFacets(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0))

	if facets == nil {
		t.Fatal("expected facets, got nil")
	}
	if len(facets.Versions) != 2 || facets.Versions[0].Value != "1.3.0" || facets.Versions[0].Count != 120 {
		t.Errorf("versions = %+v, want 1.3.0 first (empty dropped)", facets.Versions)
	}
	if len(facets.Browsers) != 2 || facets.Browsers[0].Value != "Chrome" || facets.Browsers[0].Count != 200 {
		t.Errorf("browsers = %+v, want Chrome first", facets.Browsers)
	}
	if len(facets.TopPages) != 1 || facets.TopPages[0].Value != "https://tms-min-side.nav.no/" {
		t.Errorf("topPages = %+v", facets.TopPages)
	}
}

func TestQueryIssuesFacetScopesToBrowser(t *testing.T) {
	// An active browser facet scopes the list to Faro telemetry: the browser
	// count query runs, but the server side is skipped entirely and the
	// response says facetedSource=browser with serverLogs=false.
	browserCounts := []queries.PromResult{
		{Metric: map[string]string{"hash": "111", "type": "TypeError", "value": "t.map is not a function"}, Value: queries.NewPromValue(0, "10")},
	}
	browserSessions := []queries.PromResult{
		{Metric: map[string]string{"hash": "111"}, Value: queries.NewPromValue(0, "4")},
	}
	// Registered but must never surface while a facet is active.
	serverCounts := []queries.PromResult{
		{Metric: map[string]string{"exception_type": "PSQLException", "exception_message": "boom"}, Value: queries.NewPromValue(0, "99")},
	}
	app, ds := exceptionsTestApp(t, map[string][]queries.PromResult{
		"sum by (hash":   browserCounts,
		"count by (hash": browserSessions,
		"sum by (exception_type, exception_message) (": serverCounts,
	}, nil)

	resp := app.queryIssues(context.Background(), ds, "loki-uid", "my-app", "",
		time.Unix(0, 0), time.Unix(3600, 0), browserFacets{Version: "1.2.0"})

	if resp.FacetedSource != issueSourceBrowser {
		t.Errorf("facetedSource = %q, want browser", resp.FacetedSource)
	}
	if resp.Sources.ServerLogs {
		t.Error("serverLogs should be false when a browser facet excludes the server side")
	}
	if !resp.Sources.Browser {
		t.Error("browser source should remain true")
	}
	if len(resp.Issues) != 1 || resp.Issues[0].Source != issueSourceBrowser {
		t.Fatalf("expected only the browser issue, got %+v", resp.Issues)
	}
	if resp.Issues[0].Count != 10 || resp.Issues[0].Sessions != 4 {
		t.Errorf("faceted browser issue = %+v, want count 10 / sessions 4", resp.Issues[0].ExceptionGroup)
	}
}

func TestFacetedIssueQueryShapes(t *testing.T) {
	// Guard the facet LogQL shapes: discovery uses topk(sum by (field)); the
	// faceted browser count query carries every active facet as an exact-match
	// logfmt filter, scoped by the environment; and no server-side (backend
	// log) query is issued while a browser facet is active.
	var mu sync.Mutex
	var exprs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Queries []struct {
				RefID string `json:"refId"`
				Expr  string `json:"expr"`
			} `json:"queries"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		exprs = append(exprs, req.Queries[0].Expr)
		mu.Unlock()
		writeMock(w, map[string]any{"results": map[string]any{req.Queries[0].RefID: map[string]any{}}})
	}))
	defer srv.Close()
	app := &App{otelCfg: otelconfig.Default()}
	ds := queries.NewDsQueryClient(srv.URL, "")

	app.queryIssues(context.Background(), ds, "loki-uid", "my-app", "prod",
		time.Unix(0, 0), time.Unix(3600, 0),
		browserFacets{Version: "1.2.0", Browser: "Chrome", Page: "https://tms-min-side.nav.no/"})

	mu.Lock()
	defer mu.Unlock()
	find := func(sub string) string {
		for _, e := range exprs {
			if strings.Contains(e, sub) {
				return e
			}
		}
		t.Fatalf("no query containing %q in %v", sub, exprs)
		return ""
	}

	// Facet-value discovery shapes (capped at 15, one per facet field).
	for _, want := range []string{
		`topk(15, sum by (app_version)`,
		`topk(15, sum by (browser_name)`,
		`topk(15, sum by (page_url)`,
	} {
		find(want)
	}

	// The faceted browser count query carries every active facet filter and the
	// environment scope.
	countExpr := find(`sum by (hash, type, value)`)
	for _, want := range []string{
		`app_version="1.2.0"`,
		`browser_name="Chrome"`,
		`page_url="https://tms-min-side.nav.no/"`,
		`k8s_cluster_name="prod"`,
	} {
		if !strings.Contains(countExpr, want) {
			t.Errorf("faceted count query missing %q:\n%s", want, countExpr)
		}
	}

	// No backend-log (server-side) query while a browser facet is active.
	for _, e := range exprs {
		if strings.Contains(e, "exception_type") || strings.Contains(e, "sum(count_over_time(") {
			t.Errorf("server-side query issued despite active browser facet:\n%s", e)
		}
	}
}

func TestServerExceptionQueryShapes(t *testing.T) {
	// Guard the LogQL shapes against real-Loki failure modes found live:
	//  - metric queries hard-fail when __error__-labeled (non-JSON) lines
	//    reach the aggregation → shape (b) must filter them out via the
	//    message/msg filters, shape (c) must drop __error__ explicitly;
	//  - error matching must accept pino's lowercase "error" and Loki's
	//    detected_level structured metadata;
	//  - shapes (b)/(c) must exclude semconv lines so no line is counted by
	//    two shapes.
	var mu sync.Mutex
	var exprs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Queries []struct {
				RefID string `json:"refId"`
				Expr  string `json:"expr"`
			} `json:"queries"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		exprs = append(exprs, req.Queries[0].Expr)
		mu.Unlock()
		writeMock(w, map[string]any{"results": map[string]any{req.Queries[0].RefID: map[string]any{}}})
	}))
	defer srv.Close()
	app := &App{otelCfg: otelconfig.Default()}
	ds := queries.NewDsQueryClient(srv.URL, "")

	app.queryServerExceptionGroups(context.Background(), ds, "loki-uid", "my-app", "prod", time.Unix(0, 0), time.Unix(3600, 0))

	find := func(sub string) string {
		for _, e := range exprs {
			if strings.Contains(e, sub) {
				return e
			}
		}
		t.Fatalf("no query containing %q in %v", sub, exprs)
		return ""
	}
	jsonCount := find("sum by (message, msg) (")
	for _, want := range []string{
		`exception_type=""`,
		`level=~"(?i)(error|fatal|critical)" or detected_level=~"(?i)(error|fatal|critical)"`,
		`message != "" or msg != ""`,
	} {
		if !strings.Contains(jsonCount, want) {
			t.Errorf("json count query missing %q:\n%s", want, jsonCount)
		}
	}
	plainCount := find("sum(count_over_time(")
	for _, want := range []string{
		`detected_level=~"(?i)(error|fatal|critical)"`,
		`exception_type=""`,
		`drop __error__, __error_details__`,
		`message="" | msg=""`,
	} {
		if !strings.Contains(plainCount, want) {
			t.Errorf("plain count query missing %q:\n%s", want, plainCount)
		}
	}
	semCount := find("sum by (exception_type, exception_message) (")
	if !strings.Contains(semCount, `exception_type != ""`) {
		t.Errorf("semconv count query changed unexpectedly:\n%s", semCount)
	}
	// The environment filter must scope every stream selector.
	for _, e := range exprs {
		if !strings.Contains(e, `k8s_cluster_name="prod"`) {
			t.Errorf("query missing environment filter:\n%s", e)
		}
	}
}
