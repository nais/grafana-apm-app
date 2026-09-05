package plugin

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// naisSyncFixture wires a fake nais GraphQL API and the mock annotations API
// into an App and runs one sync pass.
func naisSyncFixture(t *testing.T, deploymentsJSON string) (*mockAnnotationsAPI, func() error) {
	t.Helper()
	nais := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(deploymentsJSON))
	}))
	t.Cleanup(nais.Close)

	mock := &mockAnnotationsAPI{}
	grafana := mock.server(t)
	t.Cleanup(grafana.Close)

	app := &App{
		grafanaURL:   grafana.URL,
		healthClient: &http.Client{Timeout: 5 * time.Second},
		settings:     queries.PluginSettings{NaisAPIURL: nais.URL},
	}
	return mock, func() error { return app.syncNaisDeployments(context.Background(), "tok") }
}

const oneDeployment = `{"data":{"deployments":{"nodes":[{
  "id":"dep-1","createdAt":"2026-07-03T10:00:00Z","environmentName":"prod-gcp",
  "commitSha":"abc1234def","triggerUrl":"https://github.com/x/y/actions/runs/1","teamSlug":"team-a",
  "resources":{"nodes":[{"kind":"Application","name":"my-app"}]},
  "statuses":{"nodes":[{"state":"SUCCESS"}]}
},{
  "id":"dep-2","createdAt":"2026-07-03T11:00:00Z","environmentName":"prod-gcp",
  "commitSha":"ffff0000","triggerUrl":"","teamSlug":"team-a",
  "resources":{"nodes":[{"kind":"Application","name":"other-app"}]},
  "statuses":{"nodes":[{"state":"FAILURE"}]}
}]}}}`

func TestNaisSyncWritesDeployAnnotation(t *testing.T) {
	mock, sync := naisSyncFixture(t, oneDeployment)
	if err := sync(); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if len(mock.anns) != 1 {
		t.Fatalf("expected 1 annotation (FAILURE deploy skipped), got %d", len(mock.anns))
	}
	ann := mock.anns[0]
	tags := strings.Join(ann.Tags, ",")
	for _, want := range []string{"nais-apm:deploy", "service:my-app", "namespace:team-a", "env:prod-gcp", "version:abc1234def", "deploy-id:dep-1"} {
		if !strings.Contains(tags, want) {
			t.Errorf("missing tag %q in %v", want, ann.Tags)
		}
	}
	if !strings.Contains(ann.Text, "my-app abc1234") || !strings.Contains(ann.Text, "actions/runs/1") {
		t.Errorf("unexpected text %q", ann.Text)
	}
	wantMs := time.Date(2026, 7, 3, 10, 0, 0, 0, time.UTC).UnixMilli()
	if ann.Time != wantMs {
		t.Errorf("annotation time = %d, want deploy createdAt %d", ann.Time, wantMs)
	}
}

func TestNaisSyncIsIdempotent(t *testing.T) {
	mock, sync := naisSyncFixture(t, oneDeployment)
	if err := sync(); err != nil {
		t.Fatalf("first sync: %v", err)
	}
	if err := sync(); err != nil {
		t.Fatalf("second sync: %v", err)
	}
	if len(mock.anns) != 1 {
		t.Errorf("second sync duplicated the annotation: %d", len(mock.anns))
	}
}

func TestNaisSyncSurfacesGraphQLErrors(t *testing.T) {
	_, sync := naisSyncFixture(t, `{"errors":[{"message":"unauthorized"}]}`)
	if err := sync(); err == nil || !strings.Contains(err.Error(), "unauthorized") {
		t.Errorf("expected unauthorized error, got %v", err)
	}
}

// deployMarker builds a nais-apm:deploy annotation aged daysAgo days, in the
// default team-a namespace.
func deployMarker(id int64, service, env string, daysAgo int) grafanaAnnotation {
	return deployMarkerAt(id, "team-a", service, env, time.Now().AddDate(0, 0, -daysAgo).UnixMilli())
}

func deployMarkerAt(id int64, namespace, service, env string, timeMs int64) grafanaAnnotation {
	return grafanaAnnotation{
		ID:   id,
		Time: timeMs,
		Text: "Deployed " + service,
		Tags: []string{
			deployAnnotationTag,
			"service:" + service,
			"namespace:" + namespace,
			"env:" + env,
			"version:v" + strconv.FormatInt(id, 10),
		},
	}
}

// pruneFixture serves the given annotations (oldest first) and runs one sweep.
func pruneFixture(t *testing.T, anns []grafanaAnnotation) (*mockAnnotationsAPI, int) {
	t.Helper()
	mock := &mockAnnotationsAPI{anns: anns}
	grafana := mock.server(t)
	t.Cleanup(grafana.Close)
	app := &App{grafanaURL: grafana.URL, healthClient: &http.Client{Timeout: 5 * time.Second}}
	deleted, failed, err := app.pruneDeployAnnotations(context.Background())
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if failed != 0 {
		t.Fatalf("prune reported %d failed deletes", failed)
	}
	return mock, deleted
}

func remainingIDs(mock *mockAnnotationsAPI) []int64 {
	ids := make([]int64, 0, len(mock.anns))
	for _, ann := range mock.anns {
		ids = append(ids, ann.ID)
	}
	slices.Sort(ids)
	return ids
}

func TestPruneDeploysKeepsRecentAndNewestPerService(t *testing.T) {
	// Oldest first. app-a churns inside and outside the window; app-b has
	// nothing recent at all, so its newest marker must survive as the anchor.
	mock, deleted := pruneFixture(t, []grafanaAnnotation{
		deployMarker(1, "app-a", "prod", 400),
		deployMarker(2, "app-a", "prod", 300),
		deployMarker(3, "app-b", "prod", 250), // only app-b marker left
		deployMarker(4, "app-a", "prod", 200),
		deployMarker(5, "app-a", "prod", 10), // inside retention
		deployMarker(6, "app-a", "prod", 1),  // inside retention
	})
	if deleted != 3 {
		t.Errorf("deleted = %d, want 3", deleted)
	}
	got := remainingIDs(mock)
	want := []int64{3, 5, 6}
	if len(got) != len(want) {
		t.Fatalf("remaining = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("remaining = %v, want %v", got, want)
		}
	}
}

func TestPruneDeploysAnchorsPerEnvironment(t *testing.T) {
	// Same service, two envs: each env keeps its own newest marker.
	mock, deleted := pruneFixture(t, []grafanaAnnotation{
		deployMarker(1, "app-a", "dev", 400),
		deployMarker(2, "app-a", "prod", 380),
		deployMarker(3, "app-a", "dev", 200),
		deployMarker(4, "app-a", "prod", 150),
	})
	if deleted != 2 {
		t.Errorf("deleted = %d, want 2 (one stale marker per env)", deleted)
	}
	got := remainingIDs(mock)
	if len(got) != 2 || got[0] != 3 || got[1] != 4 {
		t.Errorf("remaining = %v, want the newest dev and prod markers [3 4]", got)
	}
}

func TestPruneDeploysLeavesEverythingInsideRetention(t *testing.T) {
	mock, deleted := pruneFixture(t, []grafanaAnnotation{
		deployMarker(1, "app-a", "prod", 89),
		deployMarker(2, "app-a", "prod", 5),
		deployMarker(3, "app-a", "prod", 0),
	})
	if deleted != 0 {
		t.Errorf("deleted = %d, want 0 — all markers are inside the %s window", deleted, deployRetention)
	}
	if len(mock.anns) != 3 {
		t.Errorf("remaining = %d, want 3", len(mock.anns))
	}
}

func TestPruneDeploysNeverTouchesTriageAnnotations(t *testing.T) {
	// A stale triage event carrying both tags must survive: the triage event
	// log is keep-all, and this is a delete path.
	stale := deployMarker(1, "app-a", "prod", 400)
	stale.Tags = append(stale.Tags, triageTag)
	mock, deleted := pruneFixture(t, []grafanaAnnotation{
		deployMarker(2, "app-a", "prod", 500), // stale, not the anchor
		stale,
		deployMarker(3, "app-a", "prod", 300), // newest: the anchor
	})
	if deleted != 1 {
		t.Fatalf("deleted = %d, want 1 (only the plain stale marker)", deleted)
	}
	got := remainingIDs(mock)
	if len(got) != 2 || got[0] != 1 || got[1] != 3 {
		t.Errorf("remaining = %v, want the triage-tagged event and the anchor [1 3]", got)
	}
}

func TestPruneDeploysKeepsAnAnchorPerNamespace(t *testing.T) {
	// Two teams shipping an app of the same name into the same environment:
	// each namespace must keep its own anchor.
	old := time.Now().AddDate(0, 0, -400).UnixMilli()
	mock, deleted := pruneFixture(t, []grafanaAnnotation{
		deployMarkerAt(1, "team-a", "backend", "prod", old),
		deployMarkerAt(2, "team-b", "backend", "prod", old+1000),
		deployMarkerAt(3, "team-a", "backend", "prod", old+2000),
		deployMarkerAt(4, "team-b", "backend", "prod", old+3000),
	})
	if deleted != 2 {
		t.Errorf("deleted = %d, want 2 (one stale marker per namespace)", deleted)
	}
	got := remainingIDs(mock)
	if len(got) != 2 || got[0] != 3 || got[1] != 4 {
		t.Errorf("remaining = %v, want each namespace's newest marker [3 4]", got)
	}
}

func TestPruneDeploysPagesPastTheFirstPage(t *testing.T) {
	// A full page of in-window markers must not stall the sweep: the stale
	// tail lives entirely below the first page's window.
	old := time.Now().AddDate(0, 0, -200).UnixMilli()
	recent := time.Now().AddDate(0, 0, -1).UnixMilli()
	var anns []grafanaAnnotation
	var id int64
	for i := 0; i < 600; i++ { // oldest first: stale tail
		id++
		anns = append(anns, deployMarkerAt(id, "team-a", "app-a", "prod", old+int64(i)*60_000))
	}
	for i := 0; i < deployPruneLimit+200; i++ { // a full page of in-window markers
		id++
		anns = append(anns, deployMarkerAt(id, "team-a", "app-a", "prod", recent+int64(i)*60_000))
	}
	mock, deleted := pruneFixture(t, anns)
	if deleted != 600 {
		t.Fatalf("deleted = %d, want 600 — the stale tail sits below page one", deleted)
	}
	if len(mock.anns) != deployPruneLimit+200 {
		t.Errorf("remaining = %d, want the %d in-window markers", len(mock.anns), deployPruneLimit+200)
	}
}

func TestPrunableDeploysSkipsUnidentifiableMarkers(t *testing.T) {
	anchored, _ := deployPruneKey([]string{"service:app-a", "namespace:team-a", "env:prod"})
	keep := map[string]bool{anchored: true}
	old := time.Now().AddDate(0, 0, -400).UnixMilli()
	cutoff := time.Now().Add(-deployRetention).UnixMilli()
	full := []string{deployAnnotationTag, "service:app-a", "namespace:team-a", "env:prod"}
	ids := prunableDeploys([]grafanaAnnotation{
		{ID: 0, Time: old, Tags: full},                                            // no id
		{ID: 7, Time: old, Tags: []string{"service:app-a", "namespace:team-a"}},   // not a deploy marker
		{ID: 8, Time: old, Tags: []string{deployAnnotationTag, "service:app-a"}},  // no namespace
		{ID: 9, Time: old, Tags: []string{deployAnnotationTag, "namespace:team"}}, // no service
		{ID: 10, Time: old, Tags: full},                                           // prunable
	}, cutoff, keep)
	if len(ids) != 1 || ids[0] != 10 {
		t.Errorf("prunable ids = %v, want [10]", ids)
	}
}

func TestPruneBackoffDelaysRetryAfterFailure(t *testing.T) {
	now := time.Now()
	// The sweep runs when time.Since(lastPrune) >= deployPruneEvery. After a
	// failure it must not run again on the next 60s tick, but must not wait a
	// full day either.
	lastPrune := nextPruneAnchor(now, errors.New("grafana down"))
	if due := now.Sub(lastPrune); due >= deployPruneEvery {
		t.Errorf("a failed sweep re-runs immediately (%s elapsed, interval %s)", due, deployPruneEvery)
	}
	nextTick := now.Add(naisSyncInterval)
	if nextTick.Sub(lastPrune) >= deployPruneEvery {
		t.Errorf("a failed sweep re-runs on the very next tick — no backoff")
	}
	afterBackoff := now.Add(deployPruneRetry)
	if afterBackoff.Sub(lastPrune) < deployPruneEvery {
		t.Errorf("a failed sweep never retries after %s", deployPruneRetry)
	}
	if got := nextPruneAnchor(now, nil); !got.Equal(now) {
		t.Errorf("successful sweep anchor = %v, want now (%v)", got, now)
	}
}

func TestPrunableDeploysTiebreaksEqualTimestampsByID(t *testing.T) {
	// The HA sync writes same-epoch duplicates by design, and Grafana orders
	// by epoch alone — so replicas can see the twins in either order. Both
	// must anchor on the same one, or they delete each other's.
	old := time.Now().AddDate(0, 0, -400).UnixMilli()
	twins := []grafanaAnnotation{
		deployMarkerAt(11, "team-a", "app-a", "prod", old),
		deployMarkerAt(12, "team-a", "app-a", "prod", old),
		deployMarkerAt(13, "team-a", "app-a", "prod", old),
	}
	cutoff := time.Now().Add(-deployRetention).UnixMilli()
	forward := prunableDeploys(twins, cutoff, map[string]bool{})
	reversed := prunableDeploys([]grafanaAnnotation{twins[2], twins[0], twins[1]}, cutoff, map[string]bool{})
	if len(forward) != 2 || forward[0] != 12 || forward[1] != 13 {
		t.Fatalf("prunable ids = %v, want the two higher ids [12 13]", forward)
	}
	if !slices.Equal(forward, reversed) {
		t.Errorf("delete set depends on arrival order: %v vs %v", forward, reversed)
	}
}
