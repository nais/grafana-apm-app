package plugin

import (
	"context"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/fingerprint"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// Distinct expr substrings per query (mockDsQueryServer matches keys against
// the posted expr, so keys must be mutually exclusive):
//
//	browser counts   → "sum by (hash"
//	browser sessions → "count by (hash"
//	server shape a   → "sum by (exception_type, exception_message) ("
//	shape a impact   → "sum by (exception_type, exception_message, k8s_pod_name)"
//	server shape b   → "sum by (message) ("
//	shape b impact   → "sum by (message, k8s_pod_name)"

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

	resp := app.queryIssues(context.Background(), ds, "loki-uid", "my-app", "prod-gcp", time.Unix(1000, 0), time.Unix(4600, 0))

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
		"sum by (message) (":             counts,
		"sum by (message, k8s_pod_name)": pods,
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
	// Both server shape queries fail (e.g. Loki series limit) — the endpoint
	// still returns the browser issues and flags serverLogs=false.
	browserCounts := []queries.PromResult{
		{Metric: map[string]string{"hash": "111", "type": "Error", "value": "boom"}, Value: queries.NewPromValue(0, "10")},
	}
	app, ds := exceptionsTestApp(t,
		map[string][]queries.PromResult{"sum by (hash": browserCounts},
		map[string]string{
			`exception_type != ""`: "maximum number of series (5000) reached for a single query",
			`stack_trace != ""`:    "maximum number of series (5000) reached for a single query",
		})

	resp := app.queryIssues(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0))

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

	resp := app.queryIssues(context.Background(), ds, "loki-uid", "my-app", "", time.Unix(0, 0), time.Unix(3600, 0))

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
