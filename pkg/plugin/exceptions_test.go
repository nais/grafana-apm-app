package plugin

import (
	"context"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/fingerprint"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

func exceptionsTestApp(t *testing.T, resultsMap map[string][]queries.PromResult) (*App, *queries.PrometheusClient) {
	t.Helper()
	srv := mockPromServer(t, resultsMap)
	t.Cleanup(srv.Close)
	app := &App{otelCfg: otelconfig.Default()}
	loki := queries.NewLokiMetricClient(srv.URL, "")
	return app, loki
}

func TestQueryExceptionGroupsMergesDynamicMessages(t *testing.T) {
	// Two upstream hash groups whose messages differ only by a UUID must merge
	// into one fingerprint group; a different exception type stays separate.
	counts := []queries.PromResult{
		{Metric: map[string]string{"hash": "111", "type": "Error", "value": "Invalid søknad 8f3a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8"}, Value: queries.NewPromValue(0, "10")},
		{Metric: map[string]string{"hash": "222", "type": "Error", "value": "Invalid søknad 91bb0000-1111-2222-3333-444455556666"}, Value: queries.NewPromValue(0, "5")},
		{Metric: map[string]string{"hash": "333", "type": "TypeError", "value": "t.map is not a function"}, Value: queries.NewPromValue(0, "3")},
	}
	sessions := []queries.PromResult{
		{Metric: map[string]string{"hash": "111"}, Value: queries.NewPromValue(0, "4")},
		{Metric: map[string]string{"hash": "222"}, Value: queries.NewPromValue(0, "2")},
		{Metric: map[string]string{"hash": "333"}, Value: queries.NewPromValue(0, "1")},
	}
	app, loki := exceptionsTestApp(t, map[string][]queries.PromResult{
		"sum by":   counts,
		"count by": sessions,
	})

	resp := app.queryExceptionGroups(context.Background(), loki, "my-app", "", time.Unix(1000, 0), time.Unix(4600, 0))

	if resp.FingerprintVersion != fingerprint.Version {
		t.Errorf("fingerprintVersion = %q", resp.FingerprintVersion)
	}
	if len(resp.Groups) != 2 {
		t.Fatalf("expected 2 groups, got %d: %+v", len(resp.Groups), resp.Groups)
	}

	merged := resp.Groups[0] // sorted by count desc → the merged group (15) first
	if merged.Count != 15 {
		t.Errorf("merged count = %v, want 15", merged.Count)
	}
	if merged.Sessions != 6 {
		t.Errorf("merged sessions = %v, want 6", merged.Sessions)
	}
	if len(merged.MemberHashes) != 2 {
		t.Errorf("memberHashes = %v, want [111 222]", merged.MemberHashes)
	}
	if merged.Title != "Error: Invalid søknad <uuid>" {
		t.Errorf("title = %q", merged.Title)
	}
	if merged.Tier != int(fingerprint.TierTypeMessage) {
		t.Errorf("tier = %d", merged.Tier)
	}

	single := resp.Groups[1]
	if single.Count != 3 || len(single.MemberHashes) != 1 || single.MemberHashes[0] != "333" {
		t.Errorf("unexpected single group: %+v", single)
	}
}

func TestQueryExceptionGroupsHashPassthrough(t *testing.T) {
	// Events with no value fall back to the upstream hash tier and never merge.
	counts := []queries.PromResult{
		{Metric: map[string]string{"hash": "444"}, Value: queries.NewPromValue(0, "7")},
	}
	app, loki := exceptionsTestApp(t, map[string][]queries.PromResult{"sum by": counts})

	resp := app.queryExceptionGroups(context.Background(), loki, "my-app", "", time.Unix(0, 0), time.Unix(60, 0))

	if len(resp.Groups) != 1 {
		t.Fatalf("expected 1 group, got %d", len(resp.Groups))
	}
	g := resp.Groups[0]
	if g.Tier != int(fingerprint.TierUpstreamHash) {
		t.Errorf("tier = %d, want %d", g.Tier, fingerprint.TierUpstreamHash)
	}
	if g.Title != "Unknown exception" {
		t.Errorf("title = %q", g.Title)
	}
}

func TestLokiWindow(t *testing.T) {
	if got := lokiWindow(time.Unix(0, 0), time.Unix(3600, 0)); got != "[3600s]" {
		t.Errorf("lokiWindow(1h) = %q", got)
	}
	if got := lokiWindow(time.Unix(0, 0), time.Unix(10, 0)); got != "[60s]" {
		t.Errorf("lokiWindow(10s) = %q, want floor 60s", got)
	}
}
