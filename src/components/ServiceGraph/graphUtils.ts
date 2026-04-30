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
const MAX_VISIBLE_PER_HOP = 6;

/** Returns true if the given ID is a collapse placeholder node */
export function isCollapseId(id: string): boolean {
  return id === DORMANT_CALLERS_ID || id === DORMANT_TARGETS_ID || id.startsWith('__dormant_h');
}

/** Returns the side ('caller' | 'target') for a collapse node */
export function collapseSide(id: string): 'caller' | 'target' {
  if (id === DORMANT_CALLERS_ID || id.endsWith('_left__')) {
    return 'caller';
  }
  return 'target';
}

/**
 * Compute which nodes/edges are visible after collapsing overflow nodes.
 * Pure function — no React dependencies.
 *
 * For single-hop (depth=1), collapses direct callers/targets beyond MAX_VISIBLE_PER_SIDE.
 * For multi-hop (depth>1), also collapses overflow at each hop level and
 * cascade-hides nodes whose parents are all hidden.
 */
export function computeVisibility(
  inputNodes: ServiceGraphNode[],
  inputEdges: ServiceGraphEdge[],
  focusNode: string | undefined,
  expandedCallers: boolean,
  expandedTargets: boolean,
  isMultiHop = false
): VisibilityResult {
  if (!focusNode || inputNodes.length <= 8) {
    return { visibleNodes: inputNodes, visibleEdges: inputEdges };
  }

  const nodeMap = new Map(inputNodes.map((n) => [n.id, n]));

  // --- 1. BFS to assign hop distance and side ---
  const hopOf = new Map<string, number>();
  const sideOf = new Map<string, 'left' | 'right'>();
  hopOf.set(focusNode, 0);

  // Hop 1: direct edges to/from focus
  for (const e of inputEdges) {
    if (e.source === focusNode && e.target !== focusNode && !hopOf.has(e.target)) {
      hopOf.set(e.target, 1);
      sideOf.set(e.target, 'right');
    }
    if (e.target === focusNode && e.source !== focusNode && !hopOf.has(e.source)) {
      hopOf.set(e.source, 1);
      sideOf.set(e.source, 'left');
    }
  }

  // Hop 2+: BFS inheriting side from parent
  if (isMultiHop) {
    for (let hop = 2; hop <= 5; hop++) {
      for (const e of inputEdges) {
        if (hopOf.get(e.source) === hop - 1 && sideOf.get(e.source) === 'right' && !hopOf.has(e.target)) {
          hopOf.set(e.target, hop);
          sideOf.set(e.target, 'right');
        }
        if (hopOf.get(e.target) === hop - 1 && sideOf.get(e.target) === 'left' && !hopOf.has(e.source)) {
          hopOf.set(e.source, hop);
          sideOf.set(e.source, 'left');
        }
      }
    }
  }

  // --- 2. Per-hop-side overflow ---
  // Group nodes by (hop, side) key
  const hopSideNodes = new Map<string, string[]>();
  for (const n of inputNodes) {
    if (n.id === focusNode) {
      continue;
    }
    const hop = hopOf.get(n.id);
    const side = sideOf.get(n.id);
    if (hop === undefined || side === undefined) {
      continue;
    }
    const key = `${hop}-${side}`;
    if (!hopSideNodes.has(key)) {
      hopSideNodes.set(key, []);
    }
    hopSideNodes.get(key)!.push(n.id);
  }

  const hiddenIds = new Set<string>();
  const hiddenToCollapse = new Map<string, string>(); // hidden node → collapse ID
  const collapseCount = new Map<string, number>(); // collapse ID → count

  for (const [key, nodeIds] of hopSideNodes) {
    const [hopStr, side] = key.split('-');
    const hop = parseInt(hopStr, 10);
    const maxVisible = hop === 1 ? MAX_VISIBLE_PER_SIDE : MAX_VISIBLE_PER_HOP;

    const isExpanded = (key === '1-left' && expandedCallers) || (key === '1-right' && expandedTargets);

    const sorted = nodeIds
      .map((id) => nodeMap.get(id)!)
      .filter(Boolean)
      .sort((a, b) => parseReqRate(b.mainStat) - parseReqRate(a.mainStat));

    if (!isExpanded && sorted.length > maxVisible) {
      const collapseId =
        hop === 1 ? (side === 'left' ? DORMANT_CALLERS_ID : DORMANT_TARGETS_ID) : `__dormant_h${hop}_${side}__`;

      const hidden = sorted.slice(maxVisible);
      for (const n of hidden) {
        hiddenIds.add(n.id);
        hiddenToCollapse.set(n.id, collapseId);
      }
      collapseCount.set(collapseId, hidden.length);
    }
  }

  // --- 3. Cascade hiding (multi-hop only) ---
  // Hide hop-2+ nodes whose ALL parents at hop-1 are hidden
  if (isMultiHop) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of inputNodes) {
        if (hiddenIds.has(n.id) || n.id === focusNode) {
          continue;
        }
        const hop = hopOf.get(n.id);
        if (!hop || hop <= 1) {
          continue;
        }
        const side = sideOf.get(n.id);
        const parents: string[] = [];
        for (const e of inputEdges) {
          if (side === 'right' && e.target === n.id && hopOf.get(e.source) === hop - 1) {
            parents.push(e.source);
          }
          if (side === 'left' && e.source === n.id && hopOf.get(e.target) === hop - 1) {
            parents.push(e.target);
          }
        }
        if (parents.length > 0 && parents.every((p) => hiddenIds.has(p))) {
          hiddenIds.add(n.id);
          changed = true;
        }
      }
    }
  }

  // --- 4. Build visible nodes + collapse placeholders ---
  const vNodes: ServiceGraphNode[] = inputNodes.filter((n) => !hiddenIds.has(n.id));

  for (const [id, count] of collapseCount) {
    vNodes.push({
      id,
      title: `+${count} more`,
      errorRate: 0,
      nodeType: 'service',
    });
  }

  // --- 5. Build visible edges with collapse rewiring ---
  const vEdges: ServiceGraphEdge[] = [];
  const visibleNodeIds = new Set(vNodes.map((n) => n.id));
  const seenEdges = new Set<string>();

  for (const e of inputEdges) {
    let source = e.source;
    let target = e.target;

    // Replace hidden endpoints with their collapse node
    if (hiddenToCollapse.has(source)) {
      source = hiddenToCollapse.get(source)!;
    }
    if (hiddenToCollapse.has(target)) {
      target = hiddenToCollapse.get(target)!;
    }

    // Skip if either endpoint is not visible (cascade-hidden without collapse mapping)
    if (!visibleNodeIds.has(source) || !visibleNodeIds.has(target)) {
      continue;
    }

    // Skip self-loops created by collapse
    if (source === target) {
      continue;
    }

    // Deduplicate collapse edges
    const edgeKey = `${source}->${target}`;
    if (seenEdges.has(edgeKey)) {
      continue;
    }
    seenEdges.add(edgeKey);

    vEdges.push({ id: edgeKey, source, target });
  }

  return { visibleNodes: vNodes, visibleEdges: vEdges };
}
