import { toGraphData } from './index';
import type { ServiceMapResponse } from '../../api/client';

describe('toGraphData', () => {
  it('returns empty arrays for null input', () => {
    const result = toGraphData(null);
    expect(result.graphNodes).toEqual([]);
    expect(result.graphEdges).toEqual([]);
  });

  it('maps nodes and edges from ServiceMapResponse', () => {
    const response: ServiceMapResponse = {
      nodes: [
        {
          id: 'frontend',
          title: 'frontend',
          mainStat: '10.0 req/s',
          secondaryStat: '1.0% errors',
          arc__errors: 0.01,
          arc__ok: 0.99,
          nodeType: 'service',
          errorRate: 0.01,
        },
        {
          id: 'postgres',
          title: 'postgres',
          mainStat: '5.0 req/s',
          secondaryStat: '0.0% errors',
          arc__errors: 0,
          arc__ok: 1,
          nodeType: 'database',
          errorRate: 0,
        },
      ],
      edges: [
        {
          id: 'frontend->postgres',
          source: 'frontend',
          target: 'postgres',
          mainStat: '5.0 req/s',
          secondaryStat: 'P95: 12ms',
        },
      ],
    };

    const result = toGraphData(response);

    expect(result.graphNodes).toHaveLength(2);
    expect(result.graphNodes[0]).toEqual({
      id: 'frontend',
      title: 'frontend',
      mainStat: '10.0 req/s',
      secondaryStat: '1.0% errors',
      errorRate: 0.01,
      nodeType: 'service',
      isHub: undefined,
      hubDegree: undefined,
    });
    expect(result.graphNodes[1].nodeType).toBe('database');

    expect(result.graphEdges).toHaveLength(1);
    expect(result.graphEdges[0].source).toBe('frontend');
    expect(result.graphEdges[0].target).toBe('postgres');
  });

  it('passes hub metadata through', () => {
    const response: ServiceMapResponse = {
      nodes: [
        {
          id: 'wonderwall',
          title: 'wonderwall',
          arc__errors: 0,
          arc__ok: 1,
          errorRate: 0,
          isHub: true,
          hubDegree: 316,
        },
      ],
      edges: [],
    };
    const result = toGraphData(response);
    expect(result.graphNodes[0].isHub).toBe(true);
    expect(result.graphNodes[0].hubDegree).toBe(316);
  });

  it('defaults errorRate to 0 when undefined', () => {
    const response: ServiceMapResponse = {
      nodes: [
        {
          id: 'svc',
          title: 'svc',
          arc__errors: 0,
          arc__ok: 1,
          errorRate: undefined as unknown as number,
        },
      ],
      edges: [],
    };

    const result = toGraphData(response);
    expect(result.graphNodes[0].errorRate).toBe(0);
  });
});
