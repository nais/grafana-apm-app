import { parseReqRate, isDormant, computeVisibility, DORMANT_CALLERS_ID, DORMANT_TARGETS_ID } from './graphUtils';
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
  // Helper to create a node
  const node = (id: string, mainStat = '10 req/s', errorRate = 0.01): ServiceGraphNode => ({
    id,
    title: id,
    mainStat,
    errorRate,
  });

  // Helper to create a dormant node (below thresholds)
  const dormant = (id: string): ServiceGraphNode => ({
    id,
    title: id,
    mainStat: '0.0 req/s',
    errorRate: 0,
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
    it('returns all nodes even with dormant ones when graph is small', () => {
      const focus = node('focus');
      const nodes = [focus, dormant('d1'), dormant('d2'), dormant('d3')];
      const edges = [edge('d1', 'focus'), edge('d2', 'focus'), edge('d3', 'focus')];
      const result = computeVisibility(nodes, edges, 'focus', false, false);
      expect(result.visibleNodes).toBe(nodes);
      expect(result.visibleEdges).toBe(edges);
    });
  });

  describe('large graph with dormant collapsing', () => {
    // Build a graph with 9+ nodes: 1 focus, 4 dormant callers, 4 active targets
    const focusN = node('focus');
    const activeCallers = [node('ac1'), node('ac2')];
    const dormantCallers = [dormant('dc1'), dormant('dc2'), dormant('dc3'), dormant('dc4')];
    const activeTargets = [node('at1'), node('at2')];
    const allNodes = [focusN, ...activeCallers, ...dormantCallers, ...activeTargets];
    const allEdges = [
      // Callers → focus
      edge('ac1', 'focus'),
      edge('ac2', 'focus'),
      edge('dc1', 'focus'),
      edge('dc2', 'focus'),
      edge('dc3', 'focus'),
      edge('dc4', 'focus'),
      // Focus → targets
      edge('focus', 'at1'),
      edge('focus', 'at2'),
    ];

    it('collapses 4 dormant callers into a single placeholder', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, false);
      // 9 original - 4 dormant + 1 placeholder = 6
      expect(result.visibleNodes).toHaveLength(6);
      const placeholder = result.visibleNodes.find((n) => n.id === DORMANT_CALLERS_ID);
      expect(placeholder).toBeDefined();
      expect(placeholder!.title).toBe('+4 dormant');
    });

    it('replaces multiple dormant caller edges with a single collapse edge', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, false);
      const collapseEdge = result.visibleEdges.find((e) => e.source === DORMANT_CALLERS_ID);
      expect(collapseEdge).toBeDefined();
      expect(collapseEdge!.target).toBe('focus');
      // Should be exactly 1 collapse edge, not 4
      const collapseEdges = result.visibleEdges.filter((e) => e.source === DORMANT_CALLERS_ID);
      expect(collapseEdges).toHaveLength(1);
    });

    it('keeps active caller edges intact', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, false);
      expect(result.visibleEdges.find((e) => e.source === 'ac1')).toBeDefined();
      expect(result.visibleEdges.find((e) => e.source === 'ac2')).toBeDefined();
    });

    it('shows all nodes when expandedCallers is true', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', true, false);
      // All 9 original nodes, no placeholders
      expect(result.visibleNodes).toHaveLength(9);
      expect(result.visibleNodes.find((n) => n.id === DORMANT_CALLERS_ID)).toBeUndefined();
    });
  });

  describe('dormant targets collapsing', () => {
    const focusN = node('focus');
    const dormantTargets = [dormant('dt1'), dormant('dt2'), dormant('dt3')];
    // Need 9+ total nodes for collapsing to kick in
    const fillerCallers = [node('c1'), node('c2'), node('c3'), node('c4'), node('c5')];
    const allNodes = [focusN, ...dormantTargets, ...fillerCallers];
    const allEdges = [
      edge('focus', 'dt1'),
      edge('focus', 'dt2'),
      edge('focus', 'dt3'),
      ...fillerCallers.map((c) => edge(c.id, 'focus')),
    ];

    it('collapses 3 dormant targets into a placeholder', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, false);
      const placeholder = result.visibleNodes.find((n) => n.id === DORMANT_TARGETS_ID);
      expect(placeholder).toBeDefined();
      expect(placeholder!.title).toBe('+3 dormant');
    });

    it('shows all nodes when expandedTargets is true', () => {
      const result = computeVisibility(allNodes, allEdges, 'focus', false, true);
      expect(result.visibleNodes.find((n) => n.id === DORMANT_TARGETS_ID)).toBeUndefined();
      expect(result.visibleNodes).toHaveLength(9); // all original
    });
  });

  describe('threshold: fewer than 3 dormant does not collapse', () => {
    const focusN = node('focus');
    const nodes = [
      focusN,
      dormant('d1'),
      dormant('d2'),
      node('a1'),
      node('a2'),
      node('a3'),
      node('a4'),
      node('a5'),
      node('a6'),
    ];
    const edges = [
      edge('d1', 'focus'),
      edge('d2', 'focus'),
      ...['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((id) => edge(id, 'focus')),
    ];

    it('does not collapse with only 2 dormant callers', () => {
      const result = computeVisibility(nodes, edges, 'focus', false, false);
      expect(result.visibleNodes.find((n) => n.id === DORMANT_CALLERS_ID)).toBeUndefined();
      expect(result.visibleNodes).toHaveLength(9); // all original
    });
  });
});
