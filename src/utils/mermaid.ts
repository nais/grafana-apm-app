import type { ServiceGraphNode, ServiceGraphEdge } from '../components/ServiceGraph';

/** Sanitize a node ID for Mermaid (no dots, colons, slashes, or spaces). */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Escape special Mermaid characters in labels. */
function escapeLabel(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/[[\](){}|<>]/g, '#$&');
}

/** Build a single-line label from title + optional subtitle. */
function nodeLabel(node: ServiceGraphNode): string {
  const parts = [node.title];
  if (node.subtitle) {
    parts.push(node.subtitle);
  }
  return escapeLabel(parts.join('\n'));
}

/** Wrap a label in the Mermaid shape delimiters for a given node type. */
function shapeWrap(id: string, label: string, nodeType?: string): string {
  switch (nodeType) {
    case 'database':
      return `    ${id}[("${label}")]`;
    case 'messaging':
      return `    ${id}{{"${label}"}}`;
    case 'external':
      return `    ${id}(["${label}"])`;
    default:
      return `    ${id}["${label}"]`;
  }
}

/**
 * Convert ServiceGraph nodes+edges to a Mermaid flowchart string.
 *
 * direction maps to Mermaid's graph direction: "DOWN" → TD, "RIGHT" → LR.
 */
export function toMermaidGraph(
  nodes: ServiceGraphNode[],
  edges: ServiceGraphEdge[],
  direction: 'RIGHT' | 'DOWN' = 'DOWN'
): string {
  const dir = direction === 'RIGHT' ? 'LR' : 'TD';
  const lines: string[] = [`graph ${dir}`];

  // Nodes
  for (const node of nodes) {
    const id = sanitizeId(node.id);
    const label = nodeLabel(node);
    lines.push(shapeWrap(id, label, node.nodeType));
  }

  if (edges.length > 0) {
    lines.push('');
  }

  // Edges
  for (const edge of edges) {
    const src = sanitizeId(edge.source);
    const tgt = sanitizeId(edge.target);
    if (edge.mainStat) {
      lines.push(`    ${src} -->|"${escapeLabel(edge.mainStat)}"| ${tgt}`);
    } else {
      lines.push(`    ${src} --> ${tgt}`);
    }
  }

  return lines.join('\n');
}
