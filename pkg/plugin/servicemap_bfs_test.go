package plugin

import (
	"testing"
)

// helper to build edge maps for tests.
func makeEdges(edges ...struct {
	client, server string
	rate           float64
	connType       string
}) map[sgEdgeKey]*sgEdgeData {
	m := make(map[sgEdgeKey]*sgEdgeData, len(edges))
	for _, e := range edges {
		m[sgEdgeKey{client: e.client, server: e.server}] = &sgEdgeData{
			rate:     e.rate,
			connType: e.connType,
		}
	}
	return m
}

func edge(client, server string, rate float64) struct {
	client, server string
	rate           float64
	connType       string
} {
	return struct {
		client, server string
		rate           float64
		connType       string
	}{client, server, rate, ""}
}

func TestInitBFSState(t *testing.T) {
	t.Run("empty edges", func(t *testing.T) {
		s := initBFSState("focus", make(map[sgEdgeKey]*sgEdgeData))
		if !s.seen["focus"] || !s.expanded["focus"] {
			t.Error("focus should be seen and expanded")
		}
		candidates := s.buildCandidates()
		if len(candidates) != 0 {
			t.Errorf("expected 0 candidates, got %d", len(candidates))
		}
	})

	t.Run("direction assignment", func(t *testing.T) {
		edges := makeEdges(
			edge("focus", "server-a", 10.0),
			edge("caller-b", "focus", 5.0),
		)
		s := initBFSState("focus", edges)
		if s.nodeDir["server-a"] != bfsDirOutbound {
			t.Error("server-a should be outbound")
		}
		if s.nodeDir["caller-b"] != bfsDirInbound {
			t.Error("caller-b should be inbound")
		}
	})

	t.Run("entry rate tracks max", func(t *testing.T) {
		edges := makeEdges(
			edge("focus", "server-a", 10.0),
			edge("server-a", "focus", 20.0),
		)
		s := initBFSState("focus", edges)
		if s.entryRate["server-a"] != 20.0 {
			t.Errorf("expected max entry rate 20.0, got %f", s.entryRate["server-a"])
		}
	})

	t.Run("infra nodes pre-computed", func(t *testing.T) {
		edges := make(map[sgEdgeKey]*sgEdgeData)
		edges[sgEdgeKey{client: "focus", server: "app-a"}] = &sgEdgeData{rate: 10.0}
		edges[sgEdgeKey{client: "focus", server: "my-db"}] = &sgEdgeData{rate: 5.0, connType: "database"}
		s := initBFSState("focus", edges)
		if !s.infraNodes["my-db"] {
			t.Error("my-db should be marked as infra node")
		}
		if s.infraNodes["app-a"] {
			t.Error("app-a should NOT be marked as infra node")
		}
	})
}

func TestBuildCandidates(t *testing.T) {
	t.Run("skips infra nodes", func(t *testing.T) {
		edges := make(map[sgEdgeKey]*sgEdgeData)
		edges[sgEdgeKey{client: "focus", server: "app-a"}] = &sgEdgeData{rate: 10.0}
		edges[sgEdgeKey{client: "focus", server: "my-db"}] = &sgEdgeData{rate: 5.0, connType: "database"}
		edges[sgEdgeKey{client: "caller-b", server: "focus"}] = &sgEdgeData{rate: 3.0}
		s := initBFSState("focus", edges)

		candidates := s.buildCandidates()
		names := make(map[string]bool)
		for _, c := range candidates {
			names[c.name] = true
		}
		if names["my-db"] {
			t.Error("infra node my-db should be skipped")
		}
		if !names["app-a"] {
			t.Error("app-a should be a candidate")
		}
		if !names["caller-b"] {
			t.Error("caller-b should be a candidate")
		}
	})

	t.Run("deterministic max rate", func(t *testing.T) {
		edges := make(map[sgEdgeKey]*sgEdgeData)
		edges[sgEdgeKey{client: "focus", server: "app-a"}] = &sgEdgeData{rate: 1.0}
		edges[sgEdgeKey{client: "app-a", server: "focus"}] = &sgEdgeData{rate: 50.0}
		s := initBFSState("focus", edges)

		candidates := s.buildCandidates()
		if len(candidates) != 1 {
			t.Fatalf("expected 1 candidate, got %d", len(candidates))
		}
		if candidates[0].rate != 50.0 {
			t.Errorf("expected max rate 50.0, got %f", candidates[0].rate)
		}
	})

	t.Run("marks candidates as seen", func(t *testing.T) {
		edges := makeEdges(
			edge("focus", "app-a", 10.0),
		)
		s := initBFSState("focus", edges)
		s.buildCandidates()
		if !s.seen["app-a"] {
			t.Error("app-a should be marked as seen after buildCandidates")
		}
	})
}

func TestFilterHubs(t *testing.T) {
	edges := makeEdges(
		edge("focus", "normal-svc", 10.0),
		edge("focus", "hub-svc", 20.0),
	)
	s := initBFSState("focus", edges)
	candidates := s.buildCandidates()

	outDegree := map[string]int{
		"normal-svc": 5,
		"hub-svc":    100, // above threshold
	}
	inDegree := map[string]int{}

	expandable := s.filterHubs(candidates, outDegree, inDegree)

	if len(expandable) != 1 {
		t.Fatalf("expected 1 expandable, got %d", len(expandable))
	}
	if expandable[0].name != "normal-svc" {
		t.Errorf("expected normal-svc, got %s", expandable[0].name)
	}
	if _, isHub := s.hubNodes["hub-svc"]; !isHub {
		t.Error("hub-svc should be in hubNodes")
	}
	if s.hubNodes["hub-svc"] != 100 {
		t.Errorf("expected hub degree 100, got %d", s.hubNodes["hub-svc"])
	}

	t.Run("exactly at threshold is hub", func(t *testing.T) {
		edges2 := makeEdges(edge("focus", "edge-case", 10.0))
		s2 := initBFSState("focus", edges2)
		c := s2.buildCandidates()
		out := map[string]int{"edge-case": hubDegreeThreshold}
		expandable2 := s2.filterHubs(c, out, map[string]int{})
		if len(expandable2) != 0 {
			t.Errorf("node at exactly hubDegreeThreshold should be a hub, got %d expandable", len(expandable2))
		}
	})
}

func TestMergeEdgesWithPruning(t *testing.T) {
	t.Run("prunes below absolute minimum", func(t *testing.T) {
		edges := makeEdges(edge("focus", "app-a", 10.0))
		s := initBFSState("focus", edges)

		hopEdges := make(map[sgEdgeKey]*sgEdgeData)
		hopEdges[sgEdgeKey{client: "app-a", server: "tiny-svc"}] = &sgEdgeData{rate: 0.0001}

		added := s.mergeEdgesWithPruning(hopEdges, true)
		if added != 0 {
			t.Errorf("expected 0 added (below absolute min), got %d", added)
		}
	})

	t.Run("prunes below relative threshold", func(t *testing.T) {
		edges := makeEdges(edge("focus", "app-a", 100.0))
		s := initBFSState("focus", edges)

		hopEdges := make(map[sgEdgeKey]*sgEdgeData)
		// 0.5 req/s is above absolute min (0.001) but below 1% of 100 = 1.0
		hopEdges[sgEdgeKey{client: "app-a", server: "low-svc"}] = &sgEdgeData{rate: 0.5}

		added := s.mergeEdgesWithPruning(hopEdges, true)
		if added != 0 {
			t.Errorf("expected 0 added (below relative threshold), got %d", added)
		}
	})

	t.Run("keeps edges above threshold", func(t *testing.T) {
		edges := makeEdges(edge("focus", "app-a", 100.0))
		s := initBFSState("focus", edges)

		hopEdges := make(map[sgEdgeKey]*sgEdgeData)
		hopEdges[sgEdgeKey{client: "app-a", server: "good-svc"}] = &sgEdgeData{rate: 5.0}

		added := s.mergeEdgesWithPruning(hopEdges, true)
		if added != 1 {
			t.Errorf("expected 1 added, got %d", added)
		}
	})

	t.Run("zero parent rate still applies absolute floor", func(t *testing.T) {
		edges := make(map[sgEdgeKey]*sgEdgeData)
		edges[sgEdgeKey{client: "focus", server: "app-a"}] = &sgEdgeData{rate: 0}
		s := initBFSState("focus", edges)

		hopEdges := make(map[sgEdgeKey]*sgEdgeData)
		hopEdges[sgEdgeKey{client: "app-a", server: "tiny"}] = &sgEdgeData{rate: 0.0001}
		hopEdges[sgEdgeKey{client: "app-a", server: "ok"}] = &sgEdgeData{rate: 0.01}

		added := s.mergeEdgesWithPruning(hopEdges, true)
		if added != 1 {
			t.Errorf("expected 1 added (ok above floor, tiny below), got %d", added)
		}
		if _, exists := s.allEdges[sgEdgeKey{client: "app-a", server: "ok"}]; !exists {
			t.Error("ok should have been added")
		}
		if _, exists := s.allEdges[sgEdgeKey{client: "app-a", server: "tiny"}]; exists {
			t.Error("tiny should have been pruned")
		}
	})

	t.Run("skips existing edges", func(t *testing.T) {
		edges := makeEdges(edge("focus", "app-a", 10.0))
		s := initBFSState("focus", edges)

		// Try to add an edge that already exists
		hopEdges := make(map[sgEdgeKey]*sgEdgeData)
		hopEdges[sgEdgeKey{client: "focus", server: "app-a"}] = &sgEdgeData{rate: 99.0}

		added := s.mergeEdgesWithPruning(hopEdges, true)
		if added != 0 {
			t.Errorf("expected 0 added (already exists), got %d", added)
		}
	})

	t.Run("tracks infra from new edges", func(t *testing.T) {
		edges := makeEdges(edge("focus", "app-a", 10.0))
		s := initBFSState("focus", edges)

		hopEdges := make(map[sgEdgeKey]*sgEdgeData)
		hopEdges[sgEdgeKey{client: "app-a", server: "new-db"}] = &sgEdgeData{
			rate:     5.0,
			connType: "database",
		}

		s.mergeEdgesWithPruning(hopEdges, true)
		if !s.infraNodes["new-db"] {
			t.Error("new-db should be tracked as infra after merge")
		}
	})
}

func TestSplitFrontier(t *testing.T) {
	edges := makeEdges(
		edge("focus", "out-a", 10.0),
		edge("caller-b", "focus", 5.0),
	)
	s := initBFSState("focus", edges)

	frontier := []frontierNode{
		{name: "out-a", rate: 10.0, dir: bfsDirOutbound},
		{name: "caller-b", rate: 5.0, dir: bfsDirInbound},
	}
	outNames, inNames := s.splitFrontier(frontier)
	if len(outNames) != 1 || outNames[0] != "out-a" {
		t.Errorf("expected outNames=[out-a], got %v", outNames)
	}
	if len(inNames) != 1 || inNames[0] != "caller-b" {
		t.Errorf("expected inNames=[caller-b], got %v", inNames)
	}

	t.Run("deduplicates normalized names", func(t *testing.T) {
		edges2 := makeEdges(
			edge("focus", "svc.ns.svc.cluster.local", 10.0),
			edge("focus", "svc.ns", 5.0),
		)
		s2 := initBFSState("focus", edges2)
		frontier2 := []frontierNode{
			{name: "svc.ns.svc.cluster.local", rate: 10.0, dir: bfsDirOutbound},
			{name: "svc.ns", rate: 5.0, dir: bfsDirOutbound},
		}
		outNames2, _ := s2.splitFrontier(frontier2)
		if len(outNames2) != 1 {
			t.Errorf("expected 1 deduplicated outbound name, got %d: %v", len(outNames2), outNames2)
		}
	})
}

func TestPreprocessServiceMapEdges_HexSuffix(t *testing.T) {
	edges := make(map[sgEdgeKey]*sgEdgeData)
	// Main service calls its hash-suffixed preview instance
	edges[sgEdgeKey{client: "nav-dekoratoren", server: "nav-dekoratoren-28e8c72f0abdc4109d600c"}] = &sgEdgeData{rate: 5.0}
	// Hash-suffixed instance calls external
	edges[sgEdgeKey{client: "nav-dekoratoren-28e8c72f0abdc4109d600c", server: "api.example.com"}] = &sgEdgeData{rate: 3.0}
	// Two hash variants calling each other — should become self-loop and be dropped
	edges[sgEdgeKey{client: "nav-dekoratoren-aabbccdd11223344", server: "nav-dekoratoren-eeff00112233aabb"}] = &sgEdgeData{rate: 1.0}

	result := preprocessServiceMapEdges(edges)

	// nav-dekoratoren → nav-dekoratoren (self-loop) should be dropped
	if _, exists := result[sgEdgeKey{client: "nav-dekoratoren", server: "nav-dekoratoren"}]; exists {
		t.Error("self-loop nav-dekoratoren → nav-dekoratoren should be dropped")
	}

	// nav-dekoratoren → api.example.com should exist (hash-suffixed client normalized)
	if _, exists := result[sgEdgeKey{client: "nav-dekoratoren", server: "api.example.com"}]; !exists {
		t.Error("nav-dekoratoren → api.example.com should exist after normalization")
	}

	// Count: should only have the one real edge
	expectedEdges := 1 // nav-dekoratoren → api.example.com
	if len(result) != expectedEdges {
		t.Errorf("expected %d edges after normalization, got %d", expectedEdges, len(result))
		for k := range result {
			t.Logf("  %s → %s", k.client, k.server)
		}
	}
}
