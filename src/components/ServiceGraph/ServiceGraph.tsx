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
import { computeVisibility, DORMANT_CALLERS_ID, DORMANT_TARGETS_ID } from './graphUtils';

export interface ServiceGraphNode {
  id: string;
  title: string;
  subtitle?: string;
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
  enableWrapping?: boolean;
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

function ServiceGraphInner({
  nodes: inputNodes,
  edges: inputEdges,
  focusNode,
  enableGrouping = false,
  enableWrapping = false,
  direction = 'RIGHT',
  onNodeClick,
}: ServiceGraphProps) {
  const styles = useStyles2(getStyles);
  const { fitView } = useReactFlow();
  const [expandedCallers, setExpandedCallers] = useState(false);
  const [expandedTargets, setExpandedTargets] = useState(false);

  // Classify nodes relative to focus: callers → focus → targets
  const { visibleNodes, visibleEdges } = useMemo(
    () => computeVisibility(inputNodes, inputEdges, focusNode, expandedCallers, expandedTargets),
    [inputNodes, inputEdges, focusNode, expandedCallers, expandedTargets]
  );

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
            subtitle: n.subtitle,
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
    enableWrapping,
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
