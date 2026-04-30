import {
  parseReqRate,
  isDormant,
  computeVisibility,
  isCollapseId,
  collapseSide,
  DORMANT_CALLERS_ID,
  DORMANT_TARGETS_ID,
} from './graphUtils';
import type { ServiceGraphNode, ServiceGraphEdge } from './ServiceGraph';

// ---------------------------------------------------------------------------
// parseReqRate
// ---------------------------------------------------------------------------

describe('parseReqRate', () => {
  it('parses standard "X.X req/s" format', () => {
    expect(parseReqRate('3.5 req/s')).toBe(3.5);
  });

  it('parses integer req/s', () => {
    expect(parseReqRate('10 req/s')).toBe(10);
  });

  it('parses "0.0 req/s"', () => {
    expect(parseReqRate('0.0 req/s')).toBe(0);
  });

  it('parses "0.04 req/s" (just below dormant threshold)', () => {
    expect(parseReqRate('0.04 req/s')).toBe(0.04);
  });

  it('parses "0.05 req/s" (at dormant threshold)', () => {
    expect(parseReqRate('0.05 req/s')).toBe(0.05);
  });

  it('returns 0 for undefined', () => {
    expect(parseReqRate(undefined)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(parseReqRate('')).toBe(0);
  });

  it('returns 0 for non-matching string', () => {
    expect(parseReqRate('5.0% errors')).toBe(0);
  });

  it('returns 0 for garbage input', () => {
    expect(parseReqRate('abc')).toBe(0);
  });

  it('parses large values', () => {
    expect(parseReqRate('1234.56 req/s')).toBe(1234.56);
  });

  it('handles "req" without "/s" suffix', () => {
    // The regex matches "req" at start after digits, so "5 requests/min" would match
    expect(parseReqRate('5 req/min')).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// isDormant
// ---------------------------------------------------------------------------

describe('isDormant', () => {
  const makeNode = (mainStat?: string, errorRate = 0): ServiceGraphNode => ({
    id: 'test',
    title: 'test',
    mainStat,
    errorRate,
  });

  it('returns true for 0 req/s and 0 error rate', () => {
    expect(isDormant(makeNode('0.0 req/s', 0))).toBe(true);
  });

  it('returns true for undefined mainStat (0 req/s) and 0 errors', () => {
    expect(isDormant(makeNode(undefined, 0))).toBe(true);
  });

  it('returns true for very low traffic below threshold', () => {
    expect(isDormant(makeNode('0.04 req/s', 0.0005))).toBe(true);
  });

  it('returns false when req/s equals threshold (0.05)', () => {
    expect(isDormant(makeNode('0.05 req/s', 0))).toBe(false);
  });

  it('returns false when req/s exceeds threshold', () => {
    expect(isDormant(makeNode('1.0 req/s', 0))).toBe(false);
  });

  it('returns false when error rate equals threshold (0.001)', () => {
    expect(isDormant(makeNode('0.01 req/s', 0.001))).toBe(false);
  });

  it('returns false when error rate exceeds threshold', () => {
    expect(isDormant(makeNode('0.01 req/s', 0.05))).toBe(false);
  });

  it('returns false for high traffic even with 0 errors', () => {
    expect(isDormant(makeNode('100 req/s', 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeVisibility
// ---------------------------------------------------------------------------

describe('computeVisibility', () => {
  // Helper to create a node with a specific rate
  const node = (id: string, mainStat = '10 req/s', errorRate = 0.01): ServiceGraphNode => ({
    id,
    title: id,
    mainStat,
    errorRate,
  });

  const edge = (source: string, target: string): ServiceGraphEdge => ({
    id: `${source}->${target}`,
    source,
    target,
  });

  describe('no focus node', () => {
    it('returns all nodes and edges unchanged', () => {
      const nodes = [node('a'), node('b')];
      const edges = [edge('a', 'b')];
      const result = computeVisibility(nodes, edges, undefined, false, false);
      expect(result.visibleNodes).toBe(nodes);
      expect(result.visibleEdges).toBe(edges);
    });
  });

  describe('small graph (<=8 nodes)', () => {
    it('returns all nodes when graph has 8 or fewer', () => {
      const focus = node('focus');
      const nodes = [focus, node('a1'), node('a2'), node('a3')];
      const edges = [edge('a1', 'focus'), edge('a2', 'focus'), edge('a3', 'focus')];
      const result = computeVisibility(nodes, edges, 'focus', false, false);
      expect(result.visibleNodes).toBe(nodes);
      expect(result.visibleEdges).toBe(edges);
    });
  });

  describe('overflow target collapsing', () => {
    // Build a graph with 1 focus + 12 targets (exceeds MAX_VISIBLE_PER_SIDE=8)
    const focusN = node('focus');
    const targets = Array.from({ length: 12 }, (_, i) => node(`t${i}`, `${12 - i} req/s`));
    const allNodes = [focusN, ...targets];
    const allEdges = targets.map((t) => edge('focus', t.id));

    it('caps targets at 8, collapsing the lowest-rate ones', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, false);
      // 1 focus + 8 targets + 1 placeholder = 10
      expect(result.visibleNodes).toHaveLength(10);
      const placeholder = result.visibleNodes.find((n) => n.id === DORMANT_TARGETS_ID);
      expect(placeholder).toBeDefined();
      expect(placeholder!.title).toBe('+4 more');
    });

    it('keeps the highest-rate targets visible', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, false);
      // t0 (12 req/s) through t7 (5 req/s) should be visible
      for (let i = 0; i < 8; i++) {
        expect(result.visibleNodes.find((n) => n.id === `t${i}`)).toBeDefined();
      }
      // t8 through t11 should be hidden
      for (let i = 8; i < 12; i++) {
        expect(result.visibleNodes.find((n) => n.id === `t${i}`)).toBeUndefined();
      }
    });

    it('replaces hidden edges with a single collapse edge', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, false);
      const collapseEdges = result.visibleEdges.filter((e) => e.target === DORMANT_TARGETS_ID);
      expect(collapseEdges).toHaveLength(1);
      expect(collapseEdges[0].source).toBe('focus');
    });

    it('shows all targets when expandedTargets is true', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, true);
      expect(result.visibleNodes).toHaveLength(13); // all original
      expect(result.visibleNodes.find((n) => n.id === DORMANT_TARGETS_ID)).toBeUndefined();
    });
  });

  describe('overflow caller collapsing', () => {
    const focusN = node('focus');
    const callers = Array.from({ length: 10 }, (_, i) => node(`c${i}`, `${10 - i} req/s`));
    const allNodes = [focusN, ...callers];
    const allEdges = callers.map((c) => edge(c.id, 'focus'));

    it('caps callers at 8, collapsing the lowest-rate ones', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, false);
      // 1 focus + 8 callers + 1 placeholder = 10
      expect(result.visibleNodes).toHaveLength(10);
      const placeholder = result.visibleNodes.find((n) => n.id === DORMANT_CALLERS_ID);
      expect(placeholder).toBeDefined();
      expect(placeholder!.title).toBe('+2 more');
    });

    it('shows all callers when expandedCallers is true', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', true, false);
      expect(result.visibleNodes).toHaveLength(11); // all original
      expect(result.visibleNodes.find((n) => n.id === DORMANT_CALLERS_ID)).toBeUndefined();
    });
  });

  describe('no collapsing when within limit', () => {
    const focusN = node('focus');
    // 8 callers (exactly at limit) + 1 target = 10 total nodes (>8 so function runs)
    const callers = Array.from({ length: 8 }, (_, i) => node(`c${i}`));
    const target = node('target');
    const allNodes = [focusN, ...callers, target];
    const allEdges = [...callers.map((c) => edge(c.id, 'focus')), edge('focus', 'target')];

    it('does not collapse when callers = 8 (at limit, not over)', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, false);
      expect(result.visibleNodes.find((n) => n.id === DORMANT_CALLERS_ID)).toBeUndefined();
      expect(result.visibleNodes).toHaveLength(10); // all original
    });
  });

  describe('edges between hidden and visible nodes are dropped', () => {
    const focusN = node('focus');
    const targets = Array.from({ length: 12 }, (_, i) => node(`t${i}`, `${12 - i} req/s`));
    const allNodes = [focusN, ...targets];
    // Normal edges from focus to each target, PLUS an edge between a hidden target and visible one
    const allEdges = [
      ...targets.map((t) => edge('focus', t.id)),
      edge('t9', 't0'), // t9 is hidden (overflow), t0 is visible
      edge('t10', 't1'), // t10 is hidden, t1 is visible
    ];

    it('drops edges from hidden nodes to visible nodes', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, false);
      // Should NOT have any edges referencing hidden nodes (t8-t11)
      const badEdges = result.visibleEdges.filter(
        (e) => e.source.startsWith('t') && parseInt(e.source.slice(1), 10) >= 8
      );
      expect(badEdges).toHaveLength(0);
    });

    it('all edge endpoints exist in visible nodes', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, false);
      const nodeIds = new Set(result.visibleNodes.map((n) => n.id));
      for (const e of result.visibleEdges) {
        expect(nodeIds.has(e.source)).toBe(true);
        expect(nodeIds.has(e.target)).toBe(true);
      }
    });
  });

  describe('self-loop does not hide focus node', () => {
    const focusN = node('focus', '1.0 req/s');
    const targets = Array.from({ length: 12 }, (_, i) => node(`t${i}`, `${12 - i} req/s`));
    const allNodes = [focusN, ...targets];
    // Normal edges + a self-loop on the focus node
    const allEdges = [...targets.map((t) => edge('focus', t.id)), edge('focus', 'focus')];

    it('focus node is never hidden even with self-loop', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, false);
      expect(result.visibleNodes.find((n) => n.id === 'focus')).toBeDefined();
    });

    it('edges from focus to visible targets still exist', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, false);
      const edgesFromFocus = result.visibleEdges.filter((e) => e.source === 'focus');
      // 8 visible targets + 1 collapse edge = at least 2 edges from focus
      expect(edgesFromFocus.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('multi-hop collapsing', () => {
    // Build a multi-hop graph:
    // Focus → 3 hop-1 targets (right), 1 hop-1 caller (left)
    // Each hop-1 target → many hop-2 targets (right)
    const buildMultiHopGraph = (hop2Count: number) => {
      const nodes: ServiceGraphNode[] = [
        node('focus', '100 req/s'),
        node('caller1', '50 req/s'),
        node('t1', '30 req/s'),
        node('t2', '20 req/s'),
        node('t3', '10 req/s'),
      ];
      const edges: ServiceGraphEdge[] = [
        edge('caller1', 'focus'),
        edge('focus', 't1'),
        edge('focus', 't2'),
        edge('focus', 't3'),
      ];

      // Add hop-2 targets from t1
      for (let i = 0; i < hop2Count; i++) {
        const id = `h2_${i}`;
        nodes.push(node(id, `${hop2Count - i} req/s`));
        edges.push(edge('t1', id));
      }
      return { nodes, edges };
    };

    it('does not collapse hop-2 nodes within limit (isMultiHop=true)', () => {
      const { nodes, edges } = buildMultiHopGraph(4); // 4 hop-2 nodes, limit is 6
      const result = computeVisibility(nodes, edges, 'focus', false, false, true);
      // All nodes should be visible (no overflow)
      expect(result.visibleNodes).toHaveLength(nodes.length);
    });

    it('collapses hop-2 overflow nodes beyond limit', () => {
      const { nodes, edges } = buildMultiHopGraph(10); // 10 hop-2 nodes, limit is 6
      const result = computeVisibility(nodes, edges, 'focus', false, false, true);

      // Should have a hop-2 collapse node
      const collapseNode = result.visibleNodes.find((n) => n.id === '__dormant_h2_right__');
      expect(collapseNode).toBeDefined();
      expect(collapseNode!.title).toBe('+4 more');

      // Top 6 hop-2 nodes (by rate) should remain visible
      for (let i = 0; i < 6; i++) {
        expect(result.visibleNodes.find((n) => n.id === `h2_${i}`)).toBeDefined();
      }
      // Bottom 4 should be hidden
      for (let i = 6; i < 10; i++) {
        expect(result.visibleNodes.find((n) => n.id === `h2_${i}`)).toBeUndefined();
      }
    });

    it('creates a single collapse edge from t1 → collapse node', () => {
      const { nodes, edges } = buildMultiHopGraph(10);
      const result = computeVisibility(nodes, edges, 'focus', false, false, true);
      const collapseEdges = result.visibleEdges.filter((e) => e.target === '__dormant_h2_right__');
      expect(collapseEdges).toHaveLength(1);
      expect(collapseEdges[0].source).toBe('t1');
    });

    it('deduplicates collapse edges from multiple parents', () => {
      // Two hop-1 targets both connect to the same set of hop-2 targets
      const nodes: ServiceGraphNode[] = [
        node('focus', '100 req/s'),
        ...Array.from({ length: 8 }, (_, i) => node(`extra${i}`, `${i} req/s`)),
        node('t1', '30 req/s'),
        node('t2', '20 req/s'),
      ];
      const edges: ServiceGraphEdge[] = [
        ...Array.from({ length: 8 }, (_, i) => edge('focus', `extra${i}`)),
        edge('focus', 't1'),
        edge('focus', 't2'),
      ];
      // Add 10 hop-2 nodes connected from BOTH t1 and t2
      for (let i = 0; i < 10; i++) {
        const id = `h2_${i}`;
        nodes.push(node(id, `${10 - i} req/s`));
        edges.push(edge('t1', id));
        edges.push(edge('t2', id));
      }

      const result = computeVisibility(nodes, edges, 'focus', false, false, true);
      // All collapse edges should be deduplicated
      const edgeKeys = result.visibleEdges.map((e) => `${e.source}->${e.target}`);
      const unique = new Set(edgeKeys);
      expect(unique.size).toBe(edgeKeys.length);
    });

    it('cascade-hides hop-3 nodes whose parents are all hidden', () => {
      // Build: focus → t1 → hop2_0..hop2_9 → hop3_x
      const nodes: ServiceGraphNode[] = [
        node('focus', '100 req/s'),
        ...Array.from({ length: 8 }, (_, i) => node(`pad${i}`, `${i} req/s`)),
        node('t1', '30 req/s'),
      ];
      const edges: ServiceGraphEdge[] = [
        ...Array.from({ length: 8 }, (_, i) => edge('focus', `pad${i}`)),
        edge('focus', 't1'),
      ];

      for (let i = 0; i < 10; i++) {
        nodes.push(node(`h2_${i}`, `${10 - i} req/s`));
        edges.push(edge('t1', `h2_${i}`));
      }

      // Add hop-3 node only connected to hidden hop-2 nodes (h2_7, h2_8)
      nodes.push(node('h3_orphan', '5 req/s'));
      edges.push(edge('h2_7', 'h3_orphan'));
      edges.push(edge('h2_8', 'h3_orphan'));

      // Add hop-3 node connected to a visible hop-2 node (h2_0)
      nodes.push(node('h3_visible', '5 req/s'));
      edges.push(edge('h2_0', 'h3_visible'));

      const result = computeVisibility(nodes, edges, 'focus', false, false, true);

      // h3_orphan should be cascade-hidden (both parents h2_7 and h2_8 are hidden)
      expect(result.visibleNodes.find((n) => n.id === 'h3_orphan')).toBeUndefined();

      // h3_visible should remain (parent h2_0 is visible)
      expect(result.visibleNodes.find((n) => n.id === 'h3_visible')).toBeDefined();
    });

    it('no self-loops in collapse edges', () => {
      const { nodes, edges } = buildMultiHopGraph(10);
      const result = computeVisibility(nodes, edges, 'focus', false, false, true);
      for (const e of result.visibleEdges) {
        expect(e.source).not.toBe(e.target);
      }
    });

    it('all edge endpoints exist in visible nodes', () => {
      const { nodes, edges } = buildMultiHopGraph(10);
      const result = computeVisibility(nodes, edges, 'focus', false, false, true);
      const ids = new Set(result.visibleNodes.map((n) => n.id));
      for (const e of result.visibleEdges) {
        expect(ids.has(e.source)).toBe(true);
        expect(ids.has(e.target)).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// isCollapseId / collapseSide
// ---------------------------------------------------------------------------

describe('isCollapseId', () => {
  it('recognizes DORMANT_CALLERS_ID', () => {
    expect(isCollapseId(DORMANT_CALLERS_ID)).toBe(true);
  });
  it('recognizes DORMANT_TARGETS_ID', () => {
    expect(isCollapseId(DORMANT_TARGETS_ID)).toBe(true);
  });
  it('recognizes hop-2 collapse IDs', () => {
    expect(isCollapseId('__dormant_h2_left__')).toBe(true);
    expect(isCollapseId('__dormant_h3_right__')).toBe(true);
  });
  it('rejects normal node IDs', () => {
    expect(isCollapseId('my-service')).toBe(false);
  });
});

describe('collapseSide', () => {
  it('returns caller for DORMANT_CALLERS_ID', () => {
    expect(collapseSide(DORMANT_CALLERS_ID)).toBe('caller');
  });
  it('returns target for DORMANT_TARGETS_ID', () => {
    expect(collapseSide(DORMANT_TARGETS_ID)).toBe('target');
  });
  it('returns caller for hop-2 left', () => {
    expect(collapseSide('__dormant_h2_left__')).toBe('caller');
  });
  it('returns target for hop-2 right', () => {
    expect(collapseSide('__dormant_h2_right__')).toBe('target');
  });
});
