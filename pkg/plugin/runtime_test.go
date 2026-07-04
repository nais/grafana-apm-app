package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// dbPoolMockServer routes /api/v1/query by matching the requested query string
// against the longest key in resultsMap that it contains. Longest-match wins so
// that a broad key (e.g. "db_client_connections_usage") does not shadow a more
// specific one (e.g. `state="idle"`). Each value is a single grouped vector.
func dbPoolMockServer(t *testing.T, resultsMap map[string][]queries.PromResult) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		query := r.URL.Query().Get("query")

		bestKey := ""
		for key := range resultsMap {
			if strings.Contains(query, key) && len(key) > len(bestKey) {
				bestKey = key
			}
		}
		result := []queries.PromResult{}
		if bestKey != "" {
			result = resultsMap[bestKey]
		}
		_ = json.NewEncoder(w).Encode(queries.PromResponse{
			Status: "success",
			Data:   queries.PromData{ResultType: "vector", Result: result},
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// poolResult builds a single grouped vector element with one label set to value.
func poolResult(label, name, value string) queries.PromResult {
	return queries.PromResult{
		Metric: map[string]string{label: name},
		Value:  queries.NewPromValue(0, value),
	}
}

func poolByName(pools []queries.DBPool) map[string]queries.DBPool {
	m := make(map[string]queries.DBPool, len(pools))
	for _, p := range pools {
		m[p.Name] = p
	}
	return m
}

func TestQueryDBPoolRuntime(t *testing.T) {
	cfg := otelconfig.Default()
	dp := cfg.Runtime.DBPool

	tests := []struct {
		name    string
		results map[string][]queries.PromResult
		// assert receives the resolved pools keyed by name.
		assert func(t *testing.T, pools map[string]queries.DBPool)
	}{
		{
			// HikariCP-only app (hikaricp_connections_* with the `pool` label):
			// the legacy shape must keep working exactly as before.
			name: "hikaricp only",
			results: map[string][]queries.PromResult{
				dp.HikariActive:  {poolResult(dp.PoolLabel, "HikariPool-1", "3")},
				dp.HikariIdle:    {poolResult(dp.PoolLabel, "HikariPool-1", "7")},
				dp.HikariMax:     {poolResult(dp.PoolLabel, "HikariPool-1", "10")},
				dp.HikariPending: {poolResult(dp.PoolLabel, "HikariPool-1", "0")},
			},
			assert: func(t *testing.T, pools map[string]queries.DBPool) {
				if len(pools) != 1 {
					t.Fatalf("want 1 pool, got %d: %+v", len(pools), pools)
				}
				p := pools["HikariPool-1"]
				if p.Type != "hikaricp" {
					t.Errorf("type = %q, want hikaricp", p.Type)
				}
				if p.Active != 3 || p.Idle != 7 || p.Max != 10 {
					t.Errorf("active/idle/max = %v/%v/%v, want 3/7/10", p.Active, p.Idle, p.Max)
				}
				if p.Utilization != 30 {
					t.Errorf("utilization = %v, want 30", p.Utilization)
				}
			},
		},
		{
			// Oracle UCP / newer OTel instrumentation: db_client_connections_*
			// with the pool_name label and a state=used|idle split. No hikaricp_*
			// at all — this is the pool that was invisible before the fix.
			name: "otel db_client_connections only",
			results: map[string][]queries.PromResult{
				usageQ(dp, dp.StateUsed): {poolResult(dp.PoolNameLabel, "UniversalConnectionPool(42)-pod-a", "4")},
				usageQ(dp, dp.StateIdle): {poolResult(dp.PoolNameLabel, "UniversalConnectionPool(42)-pod-a", "6")},
				dp.OtelDBMax:             {poolResult(dp.PoolNameLabel, "UniversalConnectionPool(42)-pod-a", "20")},
				dp.OtelDBPending:         {poolResult(dp.PoolNameLabel, "UniversalConnectionPool(42)-pod-a", "1")},
			},
			assert: func(t *testing.T, pools map[string]queries.DBPool) {
				if len(pools) != 1 {
					t.Fatalf("want 1 pool, got %d: %+v", len(pools), pools)
				}
				p := pools["UniversalConnectionPool(42)-pod-a"]
				if p.Type != "otel" {
					t.Errorf("type = %q, want otel", p.Type)
				}
				if p.Active != 4 || p.Idle != 6 || p.Max != 20 || p.Pending != 1 {
					t.Errorf("active/idle/max/pending = %v/%v/%v/%v, want 4/6/20/1", p.Active, p.Idle, p.Max, p.Pending)
				}
				if p.Utilization != 20 {
					t.Errorf("utilization = %v, want 20", p.Utilization)
				}
			},
		},
		{
			// A pool reporting via BOTH families (same name in `pool` and
			// pool_name) must be merged to a single entry, keeping the richer
			// HikariCP figures rather than being duplicated.
			name: "dedup when both families report same pool",
			results: map[string][]queries.PromResult{
				dp.HikariActive:          {poolResult(dp.PoolLabel, "HikariPool-1", "3")},
				dp.HikariIdle:            {poolResult(dp.PoolLabel, "HikariPool-1", "7")},
				dp.HikariMax:             {poolResult(dp.PoolLabel, "HikariPool-1", "10")},
				usageQ(dp, dp.StateUsed): {poolResult(dp.PoolNameLabel, "HikariPool-1", "99")},
				usageQ(dp, dp.StateIdle): {poolResult(dp.PoolNameLabel, "HikariPool-1", "99")},
				dp.OtelDBMax:             {poolResult(dp.PoolNameLabel, "HikariPool-1", "99")},
			},
			assert: func(t *testing.T, pools map[string]queries.DBPool) {
				if len(pools) != 1 {
					t.Fatalf("want 1 merged pool, got %d: %+v", len(pools), pools)
				}
				p := pools["HikariPool-1"]
				if p.Type != "hikaricp" {
					t.Errorf("type = %q, want hikaricp (richer source wins)", p.Type)
				}
				if p.Active != 3 || p.Max != 10 {
					t.Errorf("active/max = %v/%v, want 3/10 (HikariCP values kept)", p.Active, p.Max)
				}
			},
		},
		{
			// Mixed app: one HikariCP pool + one distinct UCP pool → both surface.
			name: "both families with distinct pools",
			results: map[string][]queries.PromResult{
				dp.HikariActive:          {poolResult(dp.PoolLabel, "HikariPool-1", "2")},
				dp.HikariMax:             {poolResult(dp.PoolLabel, "HikariPool-1", "8")},
				usageQ(dp, dp.StateUsed): {poolResult(dp.PoolNameLabel, "UCP-xyz", "5")},
				dp.OtelDBMax:             {poolResult(dp.PoolNameLabel, "UCP-xyz", "10")},
			},
			assert: func(t *testing.T, pools map[string]queries.DBPool) {
				if len(pools) != 2 {
					t.Fatalf("want 2 pools, got %d: %+v", len(pools), pools)
				}
				if pools["HikariPool-1"].Type != "hikaricp" {
					t.Errorf("HikariPool-1 type = %q", pools["HikariPool-1"].Type)
				}
				if pools["UCP-xyz"].Type != "otel" {
					t.Errorf("UCP-xyz type = %q", pools["UCP-xyz"].Type)
				}
			},
		},
		{
			name:    "no pools returns nil",
			results: map[string][]queries.PromResult{},
			assert: func(t *testing.T, pools map[string]queries.DBPool) {
				if len(pools) != 0 {
					t.Fatalf("want 0 pools, got %d", len(pools))
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := dbPoolMockServer(t, tt.results)
			app := &App{otelCfg: cfg}
			client := queries.NewPrometheusClient(srv.URL, "")

			got := app.queryDBPoolRuntime(context.Background(), client, `app="x"`, time.Now(), log.NewNullLogger())

			if len(tt.results) == 0 {
				if got != nil {
					t.Fatalf("want nil runtime when no pools, got %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("want non-nil runtime")
			}
			tt.assert(t, poolByName(got.Pools))
		})
	}
}

// usageQ returns the substring uniquely identifying the db_client_connections_usage
// query for a given state (used|idle), so the mock can route the two apart.
func usageQ(dp otelconfig.DBPoolMetrics, state string) string {
	var sb strings.Builder
	sb.WriteString(dp.OtelDBActive)
	sb.WriteString(`{app="x", `)
	sb.WriteString(dp.StateLabel)
	sb.WriteString(`="`)
	sb.WriteString(state)
	sb.WriteString(`"}`)
	return sb.String()
}

func TestDBPoolMaxUsesSumAcrossPods(t *testing.T) {
	// Regression (data-review R-1): replicas share the Hikari pool name, so
	// capacity must SUM per-pod max — `max by` understated it and rendered
	// idle > max on multi-pod services.
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.URL.Query().Get("query"))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(queries.PromResponse{
			Status: "success",
			Data:   queries.PromData{ResultType: "vector", Result: []queries.PromResult{}},
		})
	}))
	t.Cleanup(srv.Close)

	app := &App{otelCfg: otelconfig.Default()}
	client := queries.NewPrometheusClient(srv.URL, "tok")
	app.queryDBPoolRuntime(context.Background(), client, `service_name="svc"`, time.Unix(200000, 0), log.DefaultLogger)

	dp := otelconfig.Default().Runtime.DBPool
	var hkMax, otMax string
	mu.Lock()
	defer mu.Unlock()
	for _, q := range seen {
		if strings.Contains(q, dp.HikariMax) {
			hkMax = q
		}
		if strings.Contains(q, dp.OtelDBMax) {
			otMax = q
		}
	}
	for name, q := range map[string]string{"hkMax": hkMax, "otMax": otMax} {
		if q == "" {
			t.Fatalf("%s query not issued", name)
		}
		if !strings.HasPrefix(q, "sum by") {
			t.Errorf("%s must sum per-pod capacity, got %q", name, q)
		}
	}
}
