package plugin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sort"
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

// deployMarker builds a nais-apm:deploy annotation aged daysAgo days.
func deployMarker(id int64, service, env string, daysAgo int) grafanaAnnotation {
	return grafanaAnnotation{
		ID:   id,
		Time: time.Now().AddDate(0, 0, -daysAgo).UnixMilli(),
		Text: "Deployed " + service,
		Tags: []string{deployAnnotationTag, "service:" + service, "env:" + env, "version:v" + strconv.FormatInt(id, 10)},
	}
}

// pruneFixture serves the given annotations (oldest first) and runs one sweep.
func pruneFixture(t *testing.T, anns []grafanaAnnotation) (*mockAnnotationsAPI, int) {
	t.Helper()
	mock := &mockAnnotationsAPI{anns: anns}
	grafana := mock.server(t)
	t.Cleanup(grafana.Close)
	app := &App{grafanaURL: grafana.URL, healthClient: &http.Client{Timeout: 5 * time.Second}}
	deleted, err := app.pruneDeployAnnotations(context.Background())
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	return mock, deleted
}

func remainingIDs(mock *mockAnnotationsAPI) []int64 {
	ids := make([]int64, 0, len(mock.anns))
	for _, ann := range mock.anns {
		ids = append(ids, ann.ID)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
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

func TestPrunableDeploysSkipsUnidentifiableMarkers(t *testing.T) {
	keep := map[string]bool{"app-a/prod": true} // already anchored
	old := time.Now().AddDate(0, 0, -400).UnixMilli()
	cutoff := time.Now().Add(-deployRetention).UnixMilli()
	ids := prunableDeploys([]grafanaAnnotation{
		{ID: 0, Time: old, Tags: []string{deployAnnotationTag, "service:app-a", "env:prod"}}, // no id
		{ID: 7, Time: old, Tags: []string{"service:app-a", "env:prod"}},                      // not a deploy marker
		{ID: 8, Time: old, Tags: []string{deployAnnotationTag, "service:app-a", "env:prod"}}, // prunable
	}, cutoff, keep)
	if len(ids) != 1 || ids[0] != 8 {
		t.Errorf("prunable ids = %v, want [8]", ids)
	}
}
