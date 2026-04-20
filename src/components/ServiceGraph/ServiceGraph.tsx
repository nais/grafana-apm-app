import React, { useCallback, useMemo, useState } from 'react';
import {
  ReactFlow,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  type DefaultEdgeOptions,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { ServiceNode, type ServiceNodeData } from './nodes/ServiceNode';
import { GroupNode } from './nodes/GroupNode';
import { CollapseNode, type CollapseNodeData } from './nodes/CollapseNode';
import { useELKLayout } from './useELKLayout';

export interface ServiceGraphNode {
  id: string;
  title: string;
  mainStat?: string;
  secondaryStat?: string;
  errorRate: number;
  nodeType?: 'service' | 'database' | 'messaging' | 'external';
  namespace?: string;
}

export interface ServiceGraphEdge {
  id: string;
  source: string;
  target: string;
  mainStat?: string;
  secondaryStat?: string;
}

interface ServiceGraphProps {
  nodes: ServiceGraphNode[];
  edges: ServiceGraphEdge[];
  focusNode?: string;
  enableGrouping?: boolean;
  direction?: 'RIGHT' | 'DOWN';
  onNodeClick?: (nodeId: string) => void;
}

const nodeTypes: NodeTypes = {
  service: ServiceNode,
  group: GroupNode,
  collapse: CollapseNode,
};

const defaultEdgeOptions: DefaultEdgeOptions = {
  type: 'smoothstep',
  animated: false,
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 12,
    height: 12,
  },
};

const DORMANT_CALLERS_ID = '__dormant_callers__';
const DORMANT_TARGETS_ID = '__dormant_targets__';

/** Parse "3.5 req/s" → 3.5, returns 0 for unparsable */
function parseReqRate(stat?: string): number {
  if (!stat) {
    return 0;
  }
  const m = stat.match(/^([\d.]+)\s*req/);
  return m ? parseFloat(m[1]) : 0;
}

/** A node is dormant if it has ~0 req/s and no errors */
function isDormant(n: ServiceGraphNode): boolean {
  return parseReqRate(n.mainStat) < 0.05 && n.errorRate < 0.001;
}

function ServiceGraphInner({
  nodes: inputNodes,
  edges: inputEdges,
  focusNode,
  enableGrouping = false,
  direction = 'RIGHT',
  onNodeClick,
}: ServiceGraphProps) {
  const styles = useStyles2(getStyles);
  const { fitView } = useReactFlow();
  const [expandedCallers, setExpandedCallers] = useState(false);
  const [expandedTargets, setExpandedTargets] = useState(false);

  // Classify nodes relative to focus: callers → focus → targets
  const { visibleNodes, visibleEdges } = useMemo(() => {
    if (!focusNode || inputNodes.length <= 8) {
      // Small graphs: show everything, no collapsing
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
  }, [inputNodes, inputEdges, focusNode, expandedCallers, expandedTargets]);

  // Convert input data to React Flow format
  const rfNodes = useMemo<Node[]>(
    () =>
      visibleNodes.map((n) => {
        const isCollapseNode = n.id === DORMANT_CALLERS_ID || n.id === DORMANT_TARGETS_ID;
        if (isCollapseNode) {
          return {
            id: n.id,
            type: 'collapse',
            position: { x: 0, y: 0 },
            data: {
              label: n.title,
              count: 0,
              side: n.id === DORMANT_CALLERS_ID ? 'caller' : 'target',
            } satisfies CollapseNodeData,
          };
        }
        return {
          id: n.id,
          type: 'service',
          position: { x: 0, y: 0 },
          data: {
            label: n.title,
            mainStat: n.mainStat,
            secondaryStat: n.secondaryStat,
            errorRate: n.errorRate,
            nodeType: n.nodeType ?? 'service',
            isFocused: n.id === focusNode,
          } satisfies ServiceNodeData,
        };
      }),
    [visibleNodes, focusNode]
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      visibleEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })),
    [visibleEdges]
  );

  // Build groups from namespace if grouping is enabled
  const groups = useMemo(() => {
    if (!enableGrouping) {
      return undefined;
    }
    const nsMap = new Map<string, string[]>();
    for (const n of visibleNodes) {
      if (n.namespace) {
        const members = nsMap.get(n.namespace) ?? [];
        members.push(n.id);
        nsMap.set(n.namespace, members);
      }
    }
    const filtered = new Map<string, string[]>();
    for (const [ns, members] of nsMap) {
      if (members.length >= 2) {
        filtered.set(ns, members);
      }
    }
    return filtered.size > 0 ? filtered : undefined;
  }, [visibleNodes, enableGrouping]);

  const {
    nodes: layoutedNodes,
    edges: layoutedEdges,
    loading,
  } = useELKLayout({
    nodes: rfNodes,
    edges: rfEdges,
    groups,
    direction,
  });

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      // Expand collapse nodes
      if (node.id === DORMANT_CALLERS_ID) {
        setExpandedCallers(true);
        return;
      }
      if (node.id === DORMANT_TARGETS_ID) {
        setExpandedTargets(true);
        return;
      }
      if (node.type !== 'group' && onNodeClick) {
        onNodeClick(node.id);
      }
    },
    [onNodeClick]
  );

  // Fit view after layout completes
  React.useEffect(() => {
    if (!loading && layoutedNodes.length > 0) {
      setTimeout(() => fitView({ padding: 0.1, duration: 400 }), 100);
    }
  }, [loading, layoutedNodes.length, fitView]);

  if (loading) {
    return <div className={styles.loading}>Computing layout…</div>;
  }

  return (
    <div className={styles.wrapper}>
      <ReactFlow
        nodes={layoutedNodes}
        edges={layoutedEdges}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
      >
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function ServiceGraph(props: ServiceGraphProps) {
  return (
    <ReactFlowProvider>
      <ServiceGraphInner {...props} />
    </ReactFlowProvider>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    width: 100%;
    height: 100%;
    min-height: 500px;
    flex: 1;
    .react-flow__node {
      font-family: ${theme.typography.fontFamily};
    }
    .react-flow__edge-path {
      stroke: ${theme.colors.border.medium};
      stroke-width: 1;
    }
    .react-flow__edge:hover .react-flow__edge-path {
      stroke: ${theme.colors.primary.text};
      stroke-width: 2;
    }
    .react-flow__controls {
      border: 1px solid ${theme.colors.border.weak};
      border-radius: ${theme.shape.radius.default};
      box-shadow: ${theme.shadows.z1};
    }
    .react-flow__controls-button {
      background: ${theme.colors.background.secondary};
      border-color: ${theme.colors.border.weak};
      color: ${theme.colors.text.primary};
      &:hover {
        background: ${theme.colors.action.hover};
      }
    }
    .react-flow__background {
      background: ${theme.colors.background.canvas};
    }
  `,
  loading: css`
    display: flex;
    align-items: center;
    justify-content: center;
    height: 400px;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.body.fontSize};
  `,
});
