import { toMermaidGraph } from './mermaid';
import type { ServiceGraphNode, ServiceGraphEdge } from '../components/ServiceGraph';

describe('toMermaidGraph', () => {
  const mkNode = (id: string, overrides?: Partial<ServiceGraphNode>): ServiceGraphNode => ({
    id,
    title: id,
    errorRate: 0,
    ...overrides,
  });

  const mkEdge = (source: string, target: string, overrides?: Partial<ServiceGraphEdge>): ServiceGraphEdge => ({
    id: `${source}-${target}`,
    source,
    target,
    ...overrides,
  });

  it('produces a basic TD flowchart', () => {
    const nodes = [mkNode('a'), mkNode('b')];
    const edges = [mkEdge('a', 'b')];

    const result = toMermaidGraph(nodes, edges, 'DOWN');

    expect(result).toContain('graph TD');
    expect(result).toContain('a["a"]');
    expect(result).toContain('b["b"]');
    expect(result).toContain('a --> b');
  });

  it('uses LR for RIGHT direction', () => {
    const result = toMermaidGraph([mkNode('x')], [], 'RIGHT');
    expect(result).toContain('graph LR');
  });

  it('defaults to TD when no direction specified', () => {
    const result = toMermaidGraph([mkNode('x')], []);
    expect(result).toContain('graph TD');
  });

  it('renders database nodes as cylinders', () => {
    const nodes = [mkNode('pg', { nodeType: 'database', title: 'postgresql', subtitle: '10.0.0.1' })];
    const result = toMermaidGraph(nodes, []);
    expect(result).toContain('pg[("postgresql\n10.0.0.1")]');
  });

  it('renders messaging nodes as hexagons', () => {
    const nodes = [mkNode('kafka-broker', { nodeType: 'messaging', title: 'kafka' })];
    const result = toMermaidGraph(nodes, []);
    expect(result).toContain('kafka-broker{{"kafka"}}');
  });

  it('renders external nodes as stadiums', () => {
    const nodes = [mkNode('api.example.com', { nodeType: 'external', title: 'api.example.com' })];
    const result = toMermaidGraph(nodes, []);
    expect(result).toContain('api_example_com(["api.example.com"])');
  });

  it('includes edge labels when mainStat is present', () => {
    const edges = [mkEdge('a', 'b', { mainStat: '42.0 req/s' })];
    const result = toMermaidGraph([mkNode('a'), mkNode('b')], edges);
    expect(result).toContain('a -->|"42.0 req/s"| b');
  });

  it('sanitizes IDs with special characters', () => {
    const nodes = [mkNode('my.service/v2:latest')];
    const result = toMermaidGraph(nodes, []);
    expect(result).toContain('my_service_v2_latest["my.service/v2:latest"]');
  });

  it('escapes brackets in labels', () => {
    const nodes = [mkNode('svc', { title: 'svc [prod]' })];
    const result = toMermaidGraph(nodes, []);
    expect(result).toContain('svc["svc #[prod#]"]');
  });

  it('handles empty graph', () => {
    const result = toMermaidGraph([], []);
    expect(result).toBe('graph TD');
  });
});
