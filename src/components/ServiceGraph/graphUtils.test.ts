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
});
