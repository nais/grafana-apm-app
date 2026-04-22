/**
 * Tests for the API client module.
 *
 * We mock getBackendSrv().fetch to verify:
 * - URL construction (path + query params)
 * - Millisecond-to-second timestamp conversion
 * - Optional param handling (omitted when absent)
 * - Path segment encoding (special chars in service/namespace/dependency names)
 */

import { lastValueFrom } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import {
  getServices,
  getOperations,
  getServiceMap,
  getConnectedServices,
  getServiceDependencies,
  getGlobalDependencies,
  getDependencyDetail,
  getEndpoints,
  getGraphQLMetrics,
  getRuntimeMetrics,
  getFrontendMetrics,
} from './client';

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: jest.fn(),
}));

jest.mock('rxjs', () => ({
  lastValueFrom: jest.fn(),
}));

const mockFetch = jest.fn();
const mockLastValueFrom = lastValueFrom as jest.Mock;
const mockGetBackendSrv = getBackendSrv as jest.Mock;

/** Extract the URL from the last mockFetch call. */
function lastURL(): URL {
  const raw = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0].url as string;
  return new URL(raw, 'http://grafana.local');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBackendSrv.mockReturnValue({ fetch: mockFetch });
  mockLastValueFrom.mockResolvedValue({ data: {} });
});

describe('timeParams (via public API functions)', () => {
  it('converts milliseconds to floored seconds', async () => {
    await getOperations('ns', 'svc', 1700000000999, 1700000100001);
    const url = lastURL();
    expect(url.searchParams.get('from')).toBe('1700000000');
    expect(url.searchParams.get('to')).toBe('1700000100');
  });

  it('handles zero timestamps', async () => {
    await getOperations('ns', 'svc', 0, 999);
    const url = lastURL();
    expect(url.searchParams.get('from')).toBe('0');
    expect(url.searchParams.get('to')).toBe('0');
  });
});

describe('getServices', () => {
  it('includes step and withSeries params', async () => {
    await getServices(60000, 120000, 30, false);
    const url = lastURL();
    expect(url.pathname).toContain('/services');
    expect(url.searchParams.get('step')).toBe('30');
    expect(url.searchParams.get('withSeries')).toBe('false');
  });

  it('adds optional namespace filter', async () => {
    await getServices(60000, 120000, 60, true, { namespace: 'otel-demo' });
    const url = lastURL();
    expect(url.searchParams.get('namespace')).toBe('otel-demo');
  });

  it('adds optional environment filter', async () => {
    await getServices(60000, 120000, 60, true, { environment: 'prod-fss' });
    const url = lastURL();
    expect(url.searchParams.get('environment')).toBe('prod-fss');
  });

  it('omits namespace/environment when not provided', async () => {
    await getServices(60000, 120000);
    const url = lastURL();
    expect(url.searchParams.has('namespace')).toBe(false);
    expect(url.searchParams.has('environment')).toBe(false);
  });
});

describe('getOperations', () => {
  it('encodes namespace and service in path', async () => {
    await getOperations('ns/with/slash', 'svc with spaces', 60000, 120000);
    const url = lastURL();
    expect(url.pathname).toContain('ns%2Fwith%2Fslash');
    expect(url.pathname).toContain('svc%20with%20spaces');
    expect(url.pathname).toContain('/operations');
  });
});

describe('getServiceMap', () => {
  it('omits service/namespace when not provided', async () => {
    await getServiceMap(60000, 120000);
    const url = lastURL();
    expect(url.pathname).toContain('/service-map');
    expect(url.searchParams.has('service')).toBe(false);
    expect(url.searchParams.has('namespace')).toBe(false);
  });

  it('adds service/namespace when provided', async () => {
    await getServiceMap(60000, 120000, 'frontend', 'demo');
    const url = lastURL();
    expect(url.searchParams.get('service')).toBe('frontend');
    expect(url.searchParams.get('namespace')).toBe('demo');
  });
});

describe('getConnectedServices', () => {
  it('calls correct path', async () => {
    await getConnectedServices('demo', 'frontend', 60000, 120000);
    const url = lastURL();
    expect(url.pathname).toContain('/services/demo/frontend/connected');
  });
});

describe('getServiceDependencies', () => {
  it('adds environment filter when provided', async () => {
    await getServiceDependencies('ns', 'svc', 60000, 120000, 'prod-fss');
    const url = lastURL();
    expect(url.searchParams.get('environment')).toBe('prod-fss');
  });

  it('omits environment when not provided', async () => {
    await getServiceDependencies('ns', 'svc', 60000, 120000);
    const url = lastURL();
    expect(url.searchParams.has('environment')).toBe(false);
  });
});

describe('getGlobalDependencies', () => {
  it('calls /dependencies path', async () => {
    await getGlobalDependencies(60000, 120000);
    const url = lastURL();
    expect(url.pathname).toContain('/dependencies');
    expect(url.searchParams.has('environment')).toBe(false);
  });
});

describe('getDependencyDetail', () => {
  it('encodes dependency name with special chars', async () => {
    await getDependencyDetail('redis.example.com:6379', 60000, 120000);
    const url = lastURL();
    expect(url.pathname).toContain(encodeURIComponent('redis.example.com:6379'));
  });
});

describe('getEndpoints', () => {
  it('calls correct path', async () => {
    await getEndpoints('ns', 'svc', 60000, 120000);
    const url = lastURL();
    expect(url.pathname).toContain('/services/ns/svc/endpoints');
  });
});

describe('getFrontendMetrics', () => {
  it('omits params when no environment', async () => {
    await getFrontendMetrics('ns', 'svc');
    const url = lastURL();
    expect(url.pathname).toContain('/frontend');
    expect(url.search).toBe('');
  });

  it('adds environment when provided', async () => {
    await getFrontendMetrics('ns', 'svc', 'prod');
    const url = lastURL();
    expect(url.searchParams.get('environment')).toBe('prod');
  });
});

describe('getGraphQLMetrics', () => {
  it('calls correct path with time params', async () => {
    await getGraphQLMetrics('ns', 'svc', 60000, 120000);
    const url = lastURL();
    expect(url.pathname).toContain('/graphql');
    expect(url.searchParams.get('from')).toBe('60');
    expect(url.searchParams.get('to')).toBe('120');
  });
});

describe('getRuntimeMetrics', () => {
  it('calls correct path with time params', async () => {
    await getRuntimeMetrics('ns', 'svc', 60000, 120000);
    const url = lastURL();
    expect(url.pathname).toContain('/runtime');
    expect(url.searchParams.get('from')).toBe('60');
    expect(url.searchParams.get('to')).toBe('120');
  });
});
