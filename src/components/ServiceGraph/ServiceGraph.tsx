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
import { computeVisibility, isCollapseId, collapseSide, DORMANT_CALLERS_ID, DORMANT_TARGETS_ID } from './graphUtils';

export interface ServiceGraphNode {
  id: string;
  title: string;
  subtitle?: string;
  mainStat?: string;
  secondaryStat?: string;
  errorRate: number;
  nodeType?: 'service' | 'database' | 'messaging' | 'external';
  namespace?: string;
  isHub?: boolean;
  hubDegree?: number;
  callerCount?: number;
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
  groupBy?: 'namespace' | 'nodeType';
  enableWrapping?: boolean;
  direction?: 'RIGHT' | 'DOWN';
  isMultiHop?: boolean;
  onNodeClick?: (nodeId: string, nodeType?: string) => void;
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

function ServiceGraphInner({
  nodes: inputNodes,
  edges: inputEdges,
  focusNode,
  enableGrouping = false,
  groupBy = 'namespace',
  enableWrapping = false,
  direction = 'RIGHT',
  isMultiHop = false,
  onNodeClick,
}: ServiceGraphProps) {
  const styles = useStyles2(getStyles);
  const { fitView } = useReactFlow();
  const [expandedCallers, setExpandedCallers] = useState(false);
  const [expandedTargets, setExpandedTargets] = useState(false);

  // Classify nodes relative to focus: callers → focus → targets
  const { visibleNodes, visibleEdges } = useMemo(
    () => computeVisibility(inputNodes, inputEdges, focusNode, expandedCallers, expandedTargets, isMultiHop),
    [inputNodes, inputEdges, focusNode, expandedCallers, expandedTargets, isMultiHop]
  );

  // Convert input data to React Flow format
  const rfNodes = useMemo<Node[]>(
    () =>
      visibleNodes.map((n) => {
        if (isCollapseId(n.id)) {
          return {
            id: n.id,
            type: 'collapse',
            position: { x: 0, y: 0 },
            data: {
              label: n.title,
              count: 0,
              side: collapseSide(n.id),
            } satisfies CollapseNodeData,
          };
        }
        return {
          id: n.id,
          type: 'service',
          position: { x: 0, y: 0 },
          data: {
            label: n.title,
            subtitle: n.subtitle,
            mainStat: n.mainStat,
            secondaryStat: n.secondaryStat,
            errorRate: n.errorRate,
            nodeType: n.nodeType ?? 'service',
            isFocused: n.id === focusNode,
            isHub: n.isHub,
            hubDegree: n.hubDegree,
            callerCount: n.callerCount,
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

  // Build groups if grouping is enabled
  const groups = useMemo(() => {
    if (!enableGrouping) {
      return undefined;
    }
    const groupMap = new Map<string, string[]>();

    if (groupBy === 'nodeType') {
      const typeLabels: Record<string, string> = {
        service: 'Services',
        external: 'External',
        database: 'Databases',
        messaging: 'Messaging',
      };
      // Group by node type — skip the focus node and collapse placeholders
      for (const n of visibleNodes) {
        if (n.id === focusNode || isCollapseId(n.id)) {
          continue;
        }
        const key = typeLabels[n.nodeType ?? 'service'] ?? 'Services';
        const members = groupMap.get(key) ?? [];
        members.push(n.id);
        groupMap.set(key, members);
      }
    } else {
      // Group by namespace — skip collapse placeholders
      for (const n of visibleNodes) {
        if (isCollapseId(n.id)) {
          continue;
        }
        if (n.namespace) {
          const members = groupMap.get(n.namespace) ?? [];
          members.push(n.id);
          groupMap.set(n.namespace, members);
        }
      }
    }

    // Only keep groups with 2+ members
    const filtered = new Map<string, string[]>();
    for (const [key, members] of groupMap) {
      if (members.length >= 2) {
        filtered.set(key, members);
      }
    }
    return filtered.size > 0 ? filtered : undefined;
  }, [visibleNodes, enableGrouping, groupBy, focusNode]);

  const {
    nodes: layoutedNodes,
    edges: layoutedEdges,
    loading,
  } = useELKLayout({
    nodes: rfNodes,
    edges: rfEdges,
    groups,
    direction,
    enableWrapping,
  });

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      // Expand hop-1 collapse nodes
      if (node.id === DORMANT_CALLERS_ID) {
        setExpandedCallers(true);
        return;
      }
      if (node.id === DORMANT_TARGETS_ID) {
        setExpandedTargets(true);
        return;
      }
      // Hop-2+ collapse nodes are not expandable — ignore clicks
      if (isCollapseId(node.id)) {
        return;
      }
      if (node.type !== 'group' && onNodeClick) {
        const nodeData = node.data as ServiceNodeData | undefined;
        onNodeClick(node.id, nodeData?.nodeType);
      }
    },
    [onNodeClick]
  );

  // Fit view after layout completes
  React.useEffect(() => {
    if (!loading && layoutedNodes.length > 0) {
      const timer = setTimeout(() => fitView({ padding: 0.3, duration: 400 }), 200);
      return () => clearTimeout(timer);
    }
    return undefined;
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
        fitViewOptions={{ padding: 0.3 }}
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
