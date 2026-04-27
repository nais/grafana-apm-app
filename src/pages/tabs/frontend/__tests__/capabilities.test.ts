import { FrontendMetricsResponse } from '../../../../api/client';
import { resolveCapabilities } from '../capabilities';

describe('resolveCapabilities', () => {
  const baseResponse: FrontendMetricsResponse = {
    available: true,
    source: 'alloy-histogram',
    vitals: { lcp: 2100, fcp: 1500, cls: 0.05, inp: 180, ttfb: 600 },
    errorRate: 0.02,
    hasLoki: true,
  };

  it('resolves full capabilities for available service with Loki', () => {
    const caps = resolveCapabilities(baseResponse);
    expect(caps.available).toBe(true);
    expect(caps.hasLoki).toBe(true);
    expect(caps.vitals).toEqual(baseResponse.vitals);
    expect(caps.errorRate).toBe(0.02);
  });

  it('disables Loki when hasLoki is false', () => {
    const caps = resolveCapabilities({ ...baseResponse, hasLoki: false });
    expect(caps.available).toBe(true);
    expect(caps.hasLoki).toBe(false);
  });

  it('returns not available when response says unavailable', () => {
    const caps = resolveCapabilities({ ...baseResponse, available: false });
    expect(caps.available).toBe(false);
    expect(caps.hasLoki).toBe(false);
  });

  it('defaults errorRate to 0 when not provided', () => {
    const response = { ...baseResponse } as FrontendMetricsResponse;
    delete (response as any).errorRate;
    const caps = resolveCapabilities(response);
    expect(caps.errorRate).toBe(0);
  });

  it('preserves vitals when available', () => {
    const caps = resolveCapabilities(baseResponse);
    expect(caps.vitals).toEqual({ lcp: 2100, fcp: 1500, cls: 0.05, inp: 180, ttfb: 600 });
  });

  it('handles undefined vitals', () => {
    const caps = resolveCapabilities({ ...baseResponse, vitals: undefined });
    expect(caps.vitals).toBeUndefined();
  });
});
