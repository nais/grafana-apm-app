export { ServiceGraph } from './ServiceGraph';
export type { ServiceGraphNode, ServiceGraphEdge } from './ServiceGraph';

import type { ServiceMapResponse } from '../../api/client';
import type { ServiceGraphNode, ServiceGraphEdge } from './ServiceGraph';

/** Convert a backend ServiceMapResponse into the node/edge arrays used by ServiceGraph. */
export function toGraphData(mapData: ServiceMapResponse | null): {
  graphNodes: ServiceGraphNode[];
  graphEdges: ServiceGraphEdge[];
} {
  if (!mapData) {
    return { graphNodes: [], graphEdges: [] };
  }
  return {
    graphNodes: mapData.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      subtitle: n.subtitle,
      mainStat: n.mainStat,
      secondaryStat: n.secondaryStat,
      errorRate: n.errorRate ?? 0,
      nodeType: n.nodeType,
      isHub: n.isHub,
      hubDegree: n.hubDegree,
      callerCount: n.callerCount,
    })),
    graphEdges: mapData.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      mainStat: e.mainStat,
      secondaryStat: e.secondaryStat,
    })),
  };
}
