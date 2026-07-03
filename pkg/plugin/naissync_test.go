package plugin

import (
	"context"
	"net/http"
	"net/http/httptest"
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
