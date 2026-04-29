import type { ServiceGraphNode, ServiceGraphEdge } from './ServiceGraph';

export const DORMANT_CALLERS_ID = '__dormant_callers__';
export const DORMANT_TARGETS_ID = '__dormant_targets__';

/** Parse "3.5 req/s" → 3.5, returns 0 for unparsable */
export function parseReqRate(stat?: string): number {
  if (!stat) {
    return 0;
  }
  const m = stat.match(/^([\d.]+)\s*req/);
  return m ? parseFloat(m[1]) : 0;
}

/** A node is dormant if it has ~0 req/s and no errors */
export function isDormant(n: ServiceGraphNode): boolean {
  return parseReqRate(n.mainStat) < 0.05 && n.errorRate < 0.001;
}

export interface VisibilityResult {
  visibleNodes: ServiceGraphNode[];
  visibleEdges: ServiceGraphEdge[];
}

const MAX_VISIBLE_PER_SIDE = 8;

/**
 * Compute which nodes/edges are visible after collapsing overflow nodes.
 * Pure function — no React dependencies.
 *
 * When `isMultiHop` is true (depth > 1), per-side collapsing is skipped
 * because the graph is no longer hub-and-spoke — intermediate nodes
 * aren't direct neighbors of the focus node. The backend already caps
 * the frontier at 15 nodes per hop, bounding total node count.
 */
export function computeVisibility(
  inputNodes: ServiceGraphNode[],
  inputEdges: ServiceGraphEdge[],
  focusNode: string | undefined,
  expandedCallers: boolean,
  expandedTargets: boolean,
  isMultiHop = false
): VisibilityResult {
  if (!focusNode || inputNodes.length <= 8 || isMultiHop) {
    return { visibleNodes: inputNodes, visibleEdges: inputEdges };
  }

  // Find caller and target node IDs relative to focusNode
  const callerIds = new Set<string>();
  const targetIds = new Set<string>();
  for (const e of inputEdges) {
    // Skip self-loops — the focus node is never a caller/target of itself
    if (e.source === e.target) {
      continue;
    }
    if (e.target === focusNode) {
      callerIds.add(e.source);
    }
    if (e.source === focusNode) {
      targetIds.add(e.target);
    }
  }

  const nodeMap = new Map(inputNodes.map((n) => [n.id, n]));

  // Sort callers and targets by rate (highest first), then pick top N
  const sortByRate = (ids: Set<string>) =>
    [...ids]
      .map((id) => nodeMap.get(id))
      .filter(Boolean)
      .sort((a, b) => parseReqRate(b!.mainStat) - parseReqRate(a!.mainStat)) as ServiceGraphNode[];

  const sortedCallers = sortByRate(callerIds);
  const sortedTargets = sortByRate(targetIds);

  // Determine which nodes to hide: overflow beyond MAX_VISIBLE_PER_SIDE
  const hiddenCallerNodes =
    !expandedCallers && sortedCallers.length > MAX_VISIBLE_PER_SIDE ? sortedCallers.slice(MAX_VISIBLE_PER_SIDE) : [];
  const hiddenTargetNodes =
    !expandedTargets && sortedTargets.length > MAX_VISIBLE_PER_SIDE ? sortedTargets.slice(MAX_VISIBLE_PER_SIDE) : [];

  const hiddenCallerIds = new Set(hiddenCallerNodes.map((n) => n.id));
  const hiddenTargetIds = new Set(hiddenTargetNodes.map((n) => n.id));
  const allHidden = new Set([...hiddenCallerIds, ...hiddenTargetIds]);

  // Build visible nodes
  const vNodes: ServiceGraphNode[] = inputNodes.filter((n) => !allHidden.has(n.id));

  // Add collapse placeholder nodes
  if (hiddenCallerNodes.length > 0) {
    vNodes.push({
      id: DORMANT_CALLERS_ID,
      title: `+${hiddenCallerNodes.length} more`,
      errorRate: 0,
      nodeType: 'service',
    });
  }
  if (hiddenTargetNodes.length > 0) {
    vNodes.push({
      id: DORMANT_TARGETS_ID,
      title: `+${hiddenTargetNodes.length} more`,
      errorRate: 0,
      nodeType: 'service',
    });
  }

  // Build visible edges — replace hidden node edges with collapse node edges
  const vEdges: ServiceGraphEdge[] = [];
  const addedCollapseEdges = { callers: false, targets: false };
  const visibleNodeIds = new Set(vNodes.map((n) => n.id));

  for (const e of inputEdges) {
    if (hiddenCallerIds.has(e.source)) {
      if (!addedCollapseEdges.callers) {
        vEdges.push({
          id: `${DORMANT_CALLERS_ID}->${focusNode}`,
          source: DORMANT_CALLERS_ID,
          target: focusNode,
        });
        addedCollapseEdges.callers = true;
      }
    } else if (hiddenTargetIds.has(e.target)) {
      if (!addedCollapseEdges.targets) {
        vEdges.push({
          id: `${focusNode}->${DORMANT_TARGETS_ID}`,
          source: focusNode,
          target: DORMANT_TARGETS_ID,
        });
        addedCollapseEdges.targets = true;
      }
    } else if (visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)) {
      // Only keep edges where both endpoints are visible
      vEdges.push(e);
    }
  }

  return { visibleNodes: vNodes, visibleEdges: vEdges };
}
