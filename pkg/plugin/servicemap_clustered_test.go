package plugin

import (
	"testing"
)

// edgeWith builds a single service-graph edge with full metrics.
func edgeWith(rate, errorRate, p95 float64, connType string) *sgEdgeData {
	return &sgEdgeData{rate: rate, errorRate: errorRate, p95: p95, connType: connType}
}

func nodeByID(resp ServiceMapResponse, id string) *ServiceMapNode {
	for i := range resp.Nodes {
		if resp.Nodes[i].ID == id {
			return &resp.Nodes[i]
		}
	}
	return nil
}

func edgeByID(resp ServiceMapResponse, id string) *ServiceMapEdge {
	for i := range resp.Edges {
		if resp.Edges[i].ID == id {
			return &resp.Edges[i]
		}
	}
	return nil
}

func TestAggregateByNamespace(t *testing.T) {
	t.Run("collapses services into namespace nodes and cross-ns edges", func(t *testing.T) {
		// team-a has 2 services, team-b has 1. Cross-namespace calls:
		//   a-svc1 -> b-svc  and  a-svc2 -> b-svc  (both team-a -> team-b)
		//   a-svc1 -> a-svc2 (intra-namespace, folded into node weight only)
		edges := map[sgEdgeKey]*sgEdgeData{
			{client: "a-svc1", server: "a-svc2"}: edgeWith(10, 0, 0.1, ""),
			{client: "a-svc1", server: "b-svc"}:  edgeWith(4, 1, 0.2, ""),
			{client: "a-svc2", server: "b-svc"}:  edgeWith(6, 0, 0.3, ""),
		}
		nsMap := map[string]string{
			"a-svc1": "team-a",
			"a-svc2": "team-a",
			"b-svc":  "team-b",
		}

		resp := aggregateByNamespace(edges, nsMap)

		if len(resp.Nodes) != 2 {
			t.Fatalf("expected 2 namespace nodes, got %d", len(resp.Nodes))
		}
		teamA := nodeByID(resp, "team-a")
		teamB := nodeByID(resp, "team-b")
		if teamA == nil || teamB == nil {
			t.Fatalf("expected team-a and team-b nodes, got %+v", resp.Nodes)
		}
		if teamA.ServiceCount != 2 {
			t.Errorf("team-a ServiceCount = %d, want 2", teamA.ServiceCount)
		}
		if teamB.ServiceCount != 1 {
			t.Errorf("team-b ServiceCount = %d, want 1", teamB.ServiceCount)
		}
		// team-b incoming rate = 4 + 6 = 10; team-a incoming = 10 (intra a-svc2)
		if teamB.MainStat != "10.0 req/s" {
			t.Errorf("team-b MainStat = %q, want 10.0 req/s", teamB.MainStat)
		}
		// team-b has 1 distinct upstream namespace (team-a)
		if teamB.CallerCount != 1 {
			t.Errorf("team-b CallerCount = %d, want 1", teamB.CallerCount)
		}

		// Exactly one aggregated cross-namespace edge team-a -> team-b (rate 4+6=10)
		if len(resp.Edges) != 1 {
			t.Fatalf("expected 1 cross-namespace edge, got %d: %+v", len(resp.Edges), resp.Edges)
		}
		e := edgeByID(resp, "team-a->team-b")
		if e == nil {
			t.Fatalf("missing team-a->team-b edge, got %+v", resp.Edges)
		}
		if e.MainStat != "10.0 req/s" {
			t.Errorf("edge MainStat = %q, want 10.0 req/s (4+6 aggregated)", e.MainStat)
		}
		// p95 aggregated as max of the two edges (0.3s -> 300ms)
		if e.SecondaryStat != "P95: 300ms" {
			t.Errorf("edge SecondaryStat = %q, want P95: 300ms", e.SecondaryStat)
		}
	})

	t.Run("drops endpoints with no namespace (external/db/ip)", func(t *testing.T) {
		edges := map[sgEdgeKey]*sgEdgeData{
			{client: "a-svc", server: "b-svc"}:           edgeWith(5, 0, 0, ""),
			{client: "a-svc", server: "100.71.2.33"}:     edgeWith(3, 0, 0, "database"),
			{client: "a-svc", server: "api.example.com"}: edgeWith(2, 0, 0, ""),
		}
		nsMap := map[string]string{
			"a-svc": "team-a",
			"b-svc": "team-b",
		}

		resp := aggregateByNamespace(edges, nsMap)

		// Only team-a and team-b are nodes; the IP and external host are dropped.
		if len(resp.Nodes) != 2 {
			t.Fatalf("expected 2 nodes (external/db dropped), got %d: %+v", len(resp.Nodes), resp.Nodes)
		}
		if nodeByID(resp, "100.71.2.33") != nil {
			t.Error("database IP endpoint should be dropped from clustered view")
		}
		if len(resp.Edges) != 1 {
			t.Errorf("expected 1 cross-ns edge (external edges dropped), got %d", len(resp.Edges))
		}
	})

	t.Run("error rate aggregation and cap", func(t *testing.T) {
		// server incoming: rate 10, errors 12 -> capped at 100%
		edges := map[sgEdgeKey]*sgEdgeData{
			{client: "a-svc", server: "b-svc"}: edgeWith(10, 12, 0, ""),
		}
		nsMap := map[string]string{"a-svc": "team-a", "b-svc": "team-b"}
		resp := aggregateByNamespace(edges, nsMap)
		teamB := nodeByID(resp, "team-b")
		if teamB == nil {
			t.Fatal("missing team-b")
		}
		if teamB.ErrorRate != 1.0 {
			t.Errorf("team-b ErrorRate = %f, want 1.0 (capped)", teamB.ErrorRate)
		}
		if teamB.SecondaryStat != "100.0% errors" {
			t.Errorf("team-b SecondaryStat = %q, want 100.0%% errors", teamB.SecondaryStat)
		}
	})

	t.Run("empty edges yields empty response", func(t *testing.T) {
		resp := aggregateByNamespace(map[sgEdgeKey]*sgEdgeData{}, map[string]string{})
		if len(resp.Nodes) != 0 || len(resp.Edges) != 0 {
			t.Errorf("expected empty response, got %d nodes / %d edges", len(resp.Nodes), len(resp.Edges))
		}
	})

	t.Run("nodes sorted by service count descending", func(t *testing.T) {
		edges := map[sgEdgeKey]*sgEdgeData{
			{client: "big1", server: "big2"}:  edgeWith(1, 0, 0, ""),
			{client: "big2", server: "big3"}:  edgeWith(1, 0, 0, ""),
			{client: "small", server: "big1"}: edgeWith(1, 0, 0, ""),
		}
		nsMap := map[string]string{
			"big1": "big", "big2": "big", "big3": "big",
			"small": "small",
		}
		resp := aggregateByNamespace(edges, nsMap)
		if len(resp.Nodes) < 2 || resp.Nodes[0].ID != "big" {
			t.Errorf("expected 'big' namespace first (highest service count), got %+v", resp.Nodes)
		}
	})
}
