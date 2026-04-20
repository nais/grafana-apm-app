import React, { useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
  type DefaultEdgeOptions,
  BackgroundVariant,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { ServiceNode, type ServiceNodeData } from './nodes/ServiceNode';
import { GroupNode } from './nodes/GroupNode';
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

export interface ServiceGraphProps {
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
  direction = 'RIGHT',
  onNodeClick,
}: ServiceGraphProps) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const { fitView } = useReactFlow();

  // Convert input data to React Flow format
  const rfNodes = useMemo<Node[]>(
    () =>
      inputNodes.map((n) => ({
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
      })),
    [inputNodes, focusNode]
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      inputEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })),
    [inputEdges]
  );

  // Build groups from namespace if grouping is enabled
  const groups = useMemo(() => {
    if (!enableGrouping) {
      return undefined;
    }
    const nsMap = new Map<string, string[]>();
    for (const n of inputNodes) {
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
  }, [inputNodes, enableGrouping]);

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
        fitViewOptions={{ padding: 0.1 }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => {
            const data = n.data as ServiceNodeData | undefined;
            if (!data) {
              return '#555';
            }
            if ((data.errorRate ?? 0) > 0.05) {
              return '#f85149';
            }
            if ((data.errorRate ?? 0) > 0.01) {
              return '#d29922';
            }
            if (data.isFocused) {
              return theme.colors.primary.main;
            }
            return theme.colors.text.disabled;
          }}
          nodeStrokeWidth={0}
          nodeBorderRadius={2}
          maskColor="rgba(0,0,0,0.7)"
          style={{ background: theme.colors.background.secondary }}
        />
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
    .react-flow__minimap {
      background: ${theme.colors.background.primary};
      border: 1px solid ${theme.colors.border.weak};
      border-radius: ${theme.shape.radius.default};
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
