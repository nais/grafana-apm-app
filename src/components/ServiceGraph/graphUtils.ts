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

/**
 * Compute which nodes/edges are visible after collapsing dormant nodes.
 * Pure function — no React dependencies.
 */
export function computeVisibility(
  inputNodes: ServiceGraphNode[],
  inputEdges: ServiceGraphEdge[],
  focusNode: string | undefined,
  expandedCallers: boolean,
  expandedTargets: boolean
): VisibilityResult {
  if (!focusNode || inputNodes.length <= 8) {
    return { visibleNodes: inputNodes, visibleEdges: inputEdges };
  }

  // Find caller and target node IDs relative to focusNode
  const callerIds = new Set<string>();
  const targetIds = new Set<string>();
  for (const e of inputEdges) {
    if (e.target === focusNode) {
      callerIds.add(e.source);
    }
    if (e.source === focusNode) {
      targetIds.add(e.target);
    }
  }

  // Partition dormant callers and targets
  const dormantCallerNodes: ServiceGraphNode[] = [];
  const dormantTargetNodes: ServiceGraphNode[] = [];
  const nodeMap = new Map(inputNodes.map((n) => [n.id, n]));

  for (const id of callerIds) {
    const n = nodeMap.get(id);
    if (n && isDormant(n)) {
      dormantCallerNodes.push(n);
    }
  }
  for (const id of targetIds) {
    const n = nodeMap.get(id);
    if (n && isDormant(n)) {
      dormantTargetNodes.push(n);
    }
  }

  // Only collapse if there are 3+ dormant nodes on a side
  const collapsCallers = !expandedCallers && dormantCallerNodes.length >= 3;
  const collapsTargets = !expandedTargets && dormantTargetNodes.length >= 3;

  const hiddenCallerIds = collapsCallers ? new Set(dormantCallerNodes.map((n) => n.id)) : new Set<string>();
  const hiddenTargetIds = collapsTargets ? new Set(dormantTargetNodes.map((n) => n.id)) : new Set<string>();
  const allHidden = new Set([...hiddenCallerIds, ...hiddenTargetIds]);

  // Build visible nodes
  const vNodes: ServiceGraphNode[] = inputNodes.filter((n) => !allHidden.has(n.id));

  // Add collapse placeholder nodes
  if (collapsCallers) {
    vNodes.push({
      id: DORMANT_CALLERS_ID,
      title: `+${dormantCallerNodes.length} dormant`,
      errorRate: 0,
      nodeType: 'service',
    });
  }
  if (collapsTargets) {
    vNodes.push({
      id: DORMANT_TARGETS_ID,
      title: `+${dormantTargetNodes.length} dormant`,
      errorRate: 0,
      nodeType: 'service',
    });
  }

  // Build visible edges — replace hidden node edges with collapse node edges
  const vEdges: ServiceGraphEdge[] = [];
  const addedCollapseEdges = { callers: false, targets: false };

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
    } else {
      vEdges.push(e);
    }
  }

  return { visibleNodes: vNodes, visibleEdges: vEdges };
}
