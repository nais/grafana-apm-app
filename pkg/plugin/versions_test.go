package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// Query substring keys for mockPromServer: the sessions query hits the bare
// stream {service_name="my-app"}, the error-sessions and exceptions queries
// hit {service_name="my-app", kind="exception"} with count/sum aggregations.
const (
	versionsSessionsKey    = `count by (app_version) (count_over_time({service_name="my-app"}`
	versionsErrSessionsKey = `count by (app_version) (count_over_time({service_name="my-app", kind="exception"}`
	versionsExceptionsKey  = `sum by (app_version)`
)

func versionsTestApp(t *testing.T, resultsMap map[string][]queries.PromResult) (*App, *queries.PrometheusClient) {
	t.Helper()
	srv := mockPromServer(t, resultsMap)
	t.Cleanup(srv.Close)
	app := &App{otelCfg: otelconfig.Default()}
	loki := queries.NewLokiMetricClient(srv.URL, "")
	return app, loki
}

func TestQueryFrontendVersionsAggregation(t *testing.T) {
	sessions := []queries.PromResult{
		{Metric: map[string]string{"app_version": "aaaa111"}, Value: queries.NewPromValue(0, "100")},
		{Metric: map[string]string{"app_version": "bbbb222"}, Value: queries.NewPromValue(0, "50")},
	}
	errSessions := []queries.PromResult{
		{Metric: map[string]string{"app_version": "aaaa111"}, Value: queries.NewPromValue(0, "5")},
	}
	// cccc333 has exceptions but no sessions in range (e.g. sampled-out
	// session streams) — it must still appear, with guarded zero rates.
	exceptions := []queries.PromResult{
		{Metric: map[string]string{"app_version": "aaaa111"}, Value: queries.NewPromValue(0, "12")},
		{Metric: map[string]string{"app_version": "cccc333"}, Value: queries.NewPromValue(0, "7")},
	}
	app, loki := versionsTestApp(t, map[string][]queries.PromResult{
		versionsSessionsKey:    sessions,
		versionsErrSessionsKey: errSessions,
		versionsExceptionsKey:  exceptions,
	})

	resp := app.queryFrontendVersions(context.Background(), loki, "my-app", "", time.Unix(1000, 0), time.Unix(4600, 0))

	if resp.Unavailable {
		t.Fatal("unexpected unavailable response")
	}
	if len(resp.Versions) != 3 {
		t.Fatalf("expected 3 versions, got %d: %+v", len(resp.Versions), resp.Versions)
	}

	// Sorted by sessions desc.
	v1, v2, v3 := resp.Versions[0], resp.Versions[1], resp.Versions[2]
	if v1.Version != "aaaa111" || v2.Version != "bbbb222" || v3.Version != "cccc333" {
		t.Fatalf("unexpected order: %q, %q, %q", v1.Version, v2.Version, v3.Version)
	}

	if v1.Sessions != 100 || v1.Exceptions != 12 {
		t.Errorf("v1 sessions/exceptions = %v/%v, want 100/12", v1.Sessions, v1.Exceptions)
	}
	if v1.Adoption != roundTo(100.0/150.0, 4) {
		t.Errorf("v1 adoption = %v, want %v", v1.Adoption, roundTo(100.0/150.0, 4))
	}
	if v1.ErrorFreeRate != 0.95 {
		t.Errorf("v1 errorFreeRate = %v, want 0.95", v1.ErrorFreeRate)
	}

	if v2.Adoption != roundTo(50.0/150.0, 4) {
		t.Errorf("v2 adoption = %v", v2.Adoption)
	}
	if v2.ErrorFreeRate != 1 {
		t.Errorf("v2 errorFreeRate = %v, want 1 (no error sessions)", v2.ErrorFreeRate)
	}
	if v2.Exceptions != 0 {
		t.Errorf("v2 exceptions = %v, want 0", v2.Exceptions)
	}

	// Div-by-zero guards: no sessions → adoption 0 and errorFreeRate 0.
	if v3.Sessions != 0 || v3.Exceptions != 7 {
		t.Errorf("v3 sessions/exceptions = %v/%v, want 0/7", v3.Sessions, v3.Exceptions)
	}
	if v3.Adoption != 0 {
		t.Errorf("v3 adoption = %v, want 0", v3.Adoption)
	}
	if v3.ErrorFreeRate != 0 {
		t.Errorf("v3 errorFreeRate = %v, want 0", v3.ErrorFreeRate)
	}
}

func TestQueryFrontendVersionsNoSessionsAtAll(t *testing.T) {
	// Only exceptions, zero total sessions — the total-sessions division must
	// be guarded too.
	exceptions := []queries.PromResult{
		{Metric: map[string]string{"app_version": "dddd444"}, Value: queries.NewPromValue(0, "3")},
	}
	app, loki := versionsTestApp(t, map[string][]queries.PromResult{versionsExceptionsKey: exceptions})

	resp := app.queryFrontendVersions(context.Background(), loki, "my-app", "", time.Unix(0, 0), time.Unix(3600, 0))

	if len(resp.Versions) != 1 {
		t.Fatalf("expected 1 version, got %d", len(resp.Versions))
	}
	v := resp.Versions[0]
	if v.Adoption != 0 || v.ErrorFreeRate != 0 || v.Sessions != 0 || v.Exceptions != 3 {
		t.Errorf("unexpected stats: %+v", v)
	}
}

func TestQueryFrontendVersionsDeployEnrichment(t *testing.T) {
	var gotQuery url.Values
	annSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/annotations" {
			http.NotFound(w, r)
			return
		}
		gotQuery = r.URL.Query()
		_ = json.NewEncoder(w).Encode([]grafanaAnnotation{
			{Time: 2_000_000, Tags: []string{"nais-apm:deploy", "service:my-app", "version:bbbb222"}},
			{Time: 1_000_000, Tags: []string{"nais-apm:deploy", "service:my-app", "version:aaaa111"}},
			// Re-deploy of aaaa111: earliest marker wins for deployedAtMs.
			{Time: 1_500_000, Tags: []string{"nais-apm:deploy", "service:my-app", "version:aaaa111"}},
			// Annotation without a version tag is ignored.
			{Time: 3_000_000, Tags: []string{"nais-apm:deploy", "service:my-app"}},
		})
	}))
	t.Cleanup(annSrv.Close)

	sessions := []queries.PromResult{
		{Metric: map[string]string{"app_version": "aaaa111"}, Value: queries.NewPromValue(0, "10")},
		{Metric: map[string]string{"app_version": "bbbb222"}, Value: queries.NewPromValue(0, "5")},
	}
	// env="dev" scopes the stream selector with the cluster label.
	envSessionsKey := `count by (app_version) (count_over_time({service_name="my-app", k8s_cluster_name="dev"}`
	app, loki := versionsTestApp(t, map[string][]queries.PromResult{envSessionsKey: sessions})
	app.grafanaURL = annSrv.URL
	app.healthClient = &http.Client{}

	resp := app.queryFrontendVersions(context.Background(), loki, "my-app", "dev", time.Unix(1000, 0), time.Unix(4600, 0))

	if resp.LatestVersion != "bbbb222" {
		t.Errorf("latestVersion = %q, want bbbb222", resp.LatestVersion)
	}
	if len(resp.Versions) != 2 {
		t.Fatalf("expected 2 versions, got %d", len(resp.Versions))
	}
	if resp.Versions[0].Version != "aaaa111" || resp.Versions[0].DeployedAtMs != 1_000_000 {
		t.Errorf("aaaa111 deployedAtMs = %d, want 1000000 (earliest marker)", resp.Versions[0].DeployedAtMs)
	}
	if resp.Versions[1].DeployedAtMs != 2_000_000 {
		t.Errorf("bbbb222 deployedAtMs = %d, want 2000000", resp.Versions[1].DeployedAtMs)
	}

	// Contract tags: nais-apm:deploy + service + env (single env selected).
	wantTags := []string{"nais-apm:deploy", "service:my-app", "env:dev"}
	if got := gotQuery["tags"]; len(got) != 3 || got[0] != wantTags[0] || got[1] != wantTags[1] || got[2] != wantTags[2] {
		t.Errorf("annotation tags = %v, want %v", got, wantTags)
	}
	if gotQuery.Get("from") != "1000000" || gotQuery.Get("to") != "4600000" {
		t.Errorf("annotation range = %s..%s, want ms range", gotQuery.Get("from"), gotQuery.Get("to"))
	}
}

func TestQueryFrontendVersionsAnnotationFailureDegrades(t *testing.T) {
	annSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	t.Cleanup(annSrv.Close)

	sessions := []queries.PromResult{
		{Metric: map[string]string{"app_version": "aaaa111"}, Value: queries.NewPromValue(0, "10")},
	}
	app, loki := versionsTestApp(t, map[string][]queries.PromResult{versionsSessionsKey: sessions})
	app.grafanaURL = annSrv.URL
	app.healthClient = &http.Client{}

	resp := app.queryFrontendVersions(context.Background(), loki, "my-app", "", time.Unix(0, 0), time.Unix(3600, 0))

	if resp.Unavailable {
		t.Fatal("annotation failure must not make the response unavailable")
	}
	if resp.LatestVersion != "" {
		t.Errorf("latestVersion = %q, want empty on annotation failure", resp.LatestVersion)
	}
	if len(resp.Versions) != 1 || resp.Versions[0].DeployedAtMs != 0 {
		t.Errorf("expected version stats without deploy enrichment, got %+v", resp.Versions)
	}
}

func TestQueryFrontendVersionsCap(t *testing.T) {
	sessions := make([]queries.PromResult, 0, maxVersions+5)
	for i := 0; i < maxVersions+5; i++ {
		sessions = append(sessions, queries.PromResult{
			Metric: map[string]string{"app_version": string(rune('a'+i%26)) + "version"},
			Value:  queries.NewPromValue(0, "1"),
		})
	}
	app, loki := versionsTestApp(t, map[string][]queries.PromResult{versionsSessionsKey: sessions})

	resp := app.queryFrontendVersions(context.Background(), loki, "my-app", "", time.Unix(0, 0), time.Unix(3600, 0))

	if len(resp.Versions) > maxVersions {
		t.Errorf("got %d versions, cap is %d", len(resp.Versions), maxVersions)
	}
}
