import ELK, { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
import { useCallback, useEffect, useState } from 'react';
import { type Node, type Edge, Position } from '@xyflow/react';

interface GraphInput {
  nodes: Node[];
  edges: Edge[];
  groups?: Map<string, string[]>; // groupId → nodeIds
  direction?: 'RIGHT' | 'DOWN';
}

interface LayoutResult {
  nodes: Node[];
  edges: Edge[];
  loading: boolean;
}

const elk = new ELK();

const DEFAULT_NODE_WIDTH = 160;
const DEFAULT_NODE_HEIGHT = 42;
const GROUP_PADDING = 40;

const MAX_LAYOUT_NODES = 300;

export function useELKLayout({ nodes, edges, groups, direction = 'RIGHT' }: GraphInput): LayoutResult {
  const [layouted, setLayouted] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);

  const runLayout = useCallback(async () => {
    if (nodes.length === 0) {
      setLayouted({ nodes: [], edges: [] });
      setLoading(false);
      return;
    }

    // Guard against extremely large graphs that would block the main thread
    if (nodes.length > MAX_LAYOUT_NODES) {
      console.warn(`ELK layout skipped: ${nodes.length} nodes exceeds limit of ${MAX_LAYOUT_NODES}`);
      const fallback = nodes.map((n, i) => ({
        ...n,
        position: { x: (i % 10) * 200, y: Math.floor(i / 10) * 100 },
      }));
      setLayouted({ nodes: fallback, edges });
      setLoading(false);
      return;
    }

    const isHorizontal = direction === 'RIGHT';

    // Build ELK children — group nodes become compound parents
    const elkChildren: ElkNode[] = [];
    const nodeInGroup = new Map<string, string>();

    if (groups && groups.size > 0) {
      for (const [groupId, memberIds] of groups) {
        for (const id of memberIds) {
          nodeInGroup.set(id, groupId);
        }
        const groupChildren = memberIds
          .map((id) => nodes.find((n) => n.id === id))
          .filter(Boolean)
          .map((n) => ({
            id: n!.id,
            width: DEFAULT_NODE_WIDTH,
            height: DEFAULT_NODE_HEIGHT,
          }));
        elkChildren.push({
          id: groupId,
          children: groupChildren,
          layoutOptions: {
            'elk.padding': `[top=${GROUP_PADDING},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]`,
          },
        });
      }
    }

    // Add ungrouped nodes
    for (const n of nodes) {
      if (!nodeInGroup.has(n.id)) {
        elkChildren.push({
          id: n.id,
          width: DEFAULT_NODE_WIDTH,
          height: DEFAULT_NODE_HEIGHT,
        });
      }
    }

    const elkEdges: ElkExtendedEdge[] = edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    }));

    const elkGraph: ElkNode = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': direction,
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.spacing.nodeNode': '12',
        'elk.spacing.edgeNode': '25',
        'elk.spacing.edgeEdge': '12',
        'elk.layered.spacing.nodeNodeBetweenLayers': '100',
        'elk.layered.spacing.edgeNodeBetweenLayers': '30',
        'elk.layered.spacing.edgeEdgeBetweenLayers': '15',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        'elk.layered.compactness.connectedComponents': 'true',
        'elk.layered.mergeEdges': 'false',
      },
      children: elkChildren,
      edges: elkEdges,
    };

    try {
      const laid = await elk.layout(elkGraph);
      const positionMap = new Map<string, { x: number; y: number; parentId?: string }>();

      function extractPositions(node: ElkNode, offsetX = 0, offsetY = 0, parentId?: string) {
        if (node.id !== 'root') {
          positionMap.set(node.id, {
            x: (node.x ?? 0) + offsetX,
            y: (node.y ?? 0) + offsetY,
            parentId,
          });
        }
        if (node.children) {
          for (const child of node.children) {
            // If this node has children, it's a group — children are relative to it
            if (node.id !== 'root' && node.children.length > 0) {
              extractPositions(child, 0, 0, node.id);
            } else {
              extractPositions(child, offsetX, offsetY);
            }
          }
        }
      }
      extractPositions(laid);

      // Build positioned React Flow nodes
      const positionedNodes: Node[] = [];

      // Add group nodes first (so they render behind)
      if (groups && laid.children) {
        for (const elkChild of laid.children) {
          if (elkChild.children && elkChild.children.length > 0) {
            positionedNodes.push({
              id: elkChild.id,
              type: 'group',
              position: { x: elkChild.x ?? 0, y: elkChild.y ?? 0 },
              data: { label: elkChild.id },
              style: {
                width: elkChild.width,
                height: elkChild.height,
              },
            });
          }
        }
      }

      // Add regular nodes
      for (const n of nodes) {
        const pos = positionMap.get(n.id);
        if (!pos) {
          continue;
        }
        positionedNodes.push({
          ...n,
          position: { x: pos.x, y: pos.y },
          parentId: pos.parentId,
          sourcePosition: isHorizontal ? Position.Right : Position.Bottom,
          targetPosition: isHorizontal ? Position.Left : Position.Top,
        });
      }

      // Build edges with bend point paths
      const positionedEdges: Edge[] = edges.map((e) => ({
        ...e,
        type: 'smoothstep',
      }));

      setLayouted({ nodes: positionedNodes, edges: positionedEdges });
    } catch (err) {
      console.error('ELK layout failed:', err);
      // Fallback: use nodes as-is with sequential positioning
      const fallback = nodes.map((n, i) => ({
        ...n,
        position: { x: (i % 5) * 250, y: Math.floor(i / 5) * 120 },
      }));
      setLayouted({ nodes: fallback, edges });
    } finally {
      setLoading(false);
    }
  }, [nodes, edges, groups, direction]);

  useEffect(() => {
    setLoading(true);
    runLayout();
  }, [runLayout]);

  return { ...layouted, loading };
}
