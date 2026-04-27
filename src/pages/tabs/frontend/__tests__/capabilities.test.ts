import { FrontendMetricsResponse } from '../../../../api/client';
import { resolveCapabilities } from '../capabilities';

describe('resolveCapabilities', () => {
  const baseResponse: FrontendMetricsResponse = {
    available: true,
    source: 'alloy-histogram',
    vitals: { lcp: 2100, fcp: 1500, cls: 0.05, inp: 180, ttfb: 600 },
    errorRate: 0.02,
    metricsSource: 'alloy-histogram',
    hasLoki: true,
  };

  it('resolves full capabilities for alloy-histogram with Loki', () => {
    const caps = resolveCapabilities(baseResponse);
    expect(caps.available).toBe(true);
    expect(caps.metricsEngine).toBe('alloy-histogram');
    expect(caps.logsEngine).toBe('loki');
    expect(caps.features.has('cwvBullets')).toBe(true);
    expect(caps.features.has('cwvTrends')).toBe(true);
    expect(caps.features.has('cwvRatingBreakdown')).toBe(true);
    expect(caps.features.has('navType')).toBe(true);
    expect(caps.features.has('browserVolume')).toBe(true);
    expect(caps.features.has('perPage')).toBe(true);
    expect(caps.features.has('exceptions')).toBe(true);
    expect(caps.features.has('consoleErrors')).toBe(true);
    expect(caps.features.has('sessions')).toBe(true);
    expect(caps.features.has('trafficTimeseries')).toBe(true);
    expect(caps.vitals).toEqual(baseResponse.vitals);
    expect(caps.errorRate).toBe(0.02);
  });

  it('disables Loki features when hasLoki is false', () => {
    const caps = resolveCapabilities({ ...baseResponse, hasLoki: false });
    expect(caps.logsEngine).toBeNull();
    expect(caps.features.has('perPage')).toBe(false);
    expect(caps.features.has('exceptions')).toBe(false);
    expect(caps.features.has('consoleErrors')).toBe(false);
    expect(caps.features.has('sessions')).toBe(false);
    // Histogram features still available
    expect(caps.features.has('cwvRatingBreakdown')).toBe(true);
    expect(caps.features.has('navType')).toBe(true);
  });

  it('disables histogram-only features for loki source', () => {
    const caps = resolveCapabilities({ ...baseResponse, source: 'loki' });
    expect(caps.metricsEngine).toBe('loki');
    expect(caps.features.has('cwvRatingBreakdown')).toBe(false);
    expect(caps.features.has('navType')).toBe(false);
    expect(caps.features.has('browserVolume')).toBe(false);
    // Loki features available
    expect(caps.features.has('perPage')).toBe(true);
    expect(caps.features.has('exceptions')).toBe(true);
  });

  it('disables histogram-only features for mimir source', () => {
    const caps = resolveCapabilities({ ...baseResponse, source: 'mimir' });
    expect(caps.features.has('cwvRatingBreakdown')).toBe(false);
    expect(caps.features.has('navType')).toBe(false);
    expect(caps.features.has('browserVolume')).toBe(false);
  });

  it('returns not available when response says unavailable', () => {
    const caps = resolveCapabilities({ ...baseResponse, available: false });
    expect(caps.available).toBe(false);
    expect(caps.metricsEngine).toBeNull();
    expect(caps.logsEngine).toBeNull();
    expect(caps.features.size).toBe(0);
  });

  it('returns not available when source is missing', () => {
    const caps = resolveCapabilities({ ...baseResponse, source: undefined });
    expect(caps.available).toBe(false);
    expect(caps.features.size).toBe(0);
  });

  it('omits cwvBullets when vitals are empty', () => {
    const caps = resolveCapabilities({ ...baseResponse, vitals: {} });
    expect(caps.features.has('cwvBullets')).toBe(false);
    // Trends still available
    expect(caps.features.has('cwvTrends')).toBe(true);
  });

  it('omits cwvBullets when vitals are undefined', () => {
    const caps = resolveCapabilities({ ...baseResponse, vitals: undefined });
    expect(caps.features.has('cwvBullets')).toBe(false);
  });

  it('defaults errorRate to 0 when not provided', () => {
    const response = { ...baseResponse } as FrontendMetricsResponse;
    delete (response as any).errorRate;
    const caps = resolveCapabilities(response);
    expect(caps.errorRate).toBe(0);
  });

  it('handles alloy source (legacy, no histogram)', () => {
    const caps = resolveCapabilities({ ...baseResponse, source: 'alloy' });
    expect(caps.metricsEngine).toBe('alloy');
    expect(caps.features.has('cwvRatingBreakdown')).toBe(false);
    expect(caps.features.has('cwvTrends')).toBe(true);
    expect(caps.features.has('trafficTimeseries')).toBe(true);
  });
});
