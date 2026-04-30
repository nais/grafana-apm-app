import { buildServiceScene, BuildServiceSceneParams } from './buildServiceScene';

const defaultParams: BuildServiceSceneParams = {
  service: 'frontend',
  namespace: 'otel-demo',
  envFilter: 'production',
  percentile: '0.95',
  percentileLabel: 'P95',
  from: 'now-1h',
  to: 'now',
  metricsUid: 'prometheus-uid',
  tracesUid: 'tempo-uid',
  logsUid: 'loki-uid',
  callsMetric: 'traces_spanmetrics_calls_total',
  durationBucket: 'traces_spanmetrics_duration_milliseconds_bucket',
  durationUnit: 'ms',
  hasServerSpans: true,
};

describe('buildServiceScene', () => {
  it('returns null when callsMetric is empty', () => {
    const scene = buildServiceScene({ ...defaultParams, callsMetric: '' });
    expect(scene).toBeNull();
  });

  it('returns null when durationBucket is empty', () => {
    const scene = buildServiceScene({ ...defaultParams, durationBucket: '' });
    expect(scene).toBeNull();
  });

  it('returns null when metricsUid is empty', () => {
    const scene = buildServiceScene({ ...defaultParams, metricsUid: '' });
    expect(scene).toBeNull();
  });

  it('returns a valid EmbeddedScene when all required params are provided', () => {
    const scene = buildServiceScene(defaultParams);
    expect(scene).not.toBeNull();
    expect(scene!.state).toBeDefined();
  });

  it('includes service and namespace in scene queries', () => {
    const scene = buildServiceScene(defaultParams);
    expect(scene).not.toBeNull();

    const body = scene!.state.body;
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('frontend');
    expect(serialized).toContain('otel-demo');
  });

  it('includes environment filter when provided', () => {
    const scene = buildServiceScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('production');
  });

  it('omits environment filter when envFilter is empty', () => {
    const scene = buildServiceScene({ ...defaultParams, envFilter: '' });
    expect(scene).not.toBeNull();
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('frontend');
  });

  it('uses SERVER span kind filter when hasServerSpans is true', () => {
    const scene = buildServiceScene({ ...defaultParams, hasServerSpans: true });
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('SPAN_KIND_SERVER');
  });

  it('omits span kind filter when hasServerSpans is false', () => {
    const scene = buildServiceScene({ ...defaultParams, hasServerSpans: false });
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).not.toContain('SPAN_KIND_SERVER');
  });
});
