import { getMetricNames } from './capabilities';
import { Capabilities } from '../api/client';

describe('getMetricNames', () => {
  it('returns defaults when caps is null', () => {
    const result = getMetricNames(null);
    expect(result.callsMetric).toBe('traces_span_metrics_calls_total');
    expect(result.durationBucket).toBe('traces_span_metrics_duration_milliseconds_bucket');
    expect(result.durationUnit).toBe('ms');
  });

  it('uses detected span metrics with durationMetric', () => {
    const caps: Capabilities = {
      spanMetrics: {
        detected: true,
        namespace: 'my_app_metrics',
        callsMetric: 'my_app_metrics_calls_total',
        durationMetric: 'my_app_metrics_duration_seconds_bucket',
        durationUnit: 's',
      },
      serviceGraph: { detected: false },
      tempo: { available: true },
      loki: { available: false },
      services: [],
    };

    const result = getMetricNames(caps);
    expect(result.callsMetric).toBe('my_app_metrics_calls_total');
    expect(result.durationBucket).toBe('my_app_metrics_duration_seconds_bucket');
    expect(result.durationUnit).toBe('s');
  });

  it('uses Tempo latency naming when detected', () => {
    const caps: Capabilities = {
      spanMetrics: {
        detected: true,
        namespace: 'traces_spanmetrics',
        callsMetric: 'traces_spanmetrics_calls_total',
        durationMetric: 'traces_spanmetrics_latency_bucket',
        durationUnit: 's',
      },
      serviceGraph: { detected: true },
      tempo: { available: true },
      loki: { available: true },
      services: ['frontend', 'backend'],
    };

    const result = getMetricNames(caps);
    expect(result.durationBucket).toBe('traces_spanmetrics_latency_bucket');
  });

  it('falls back to defaults for partial capabilities', () => {
    const caps: Capabilities = {
      spanMetrics: { detected: false },
      serviceGraph: { detected: false },
      tempo: { available: false },
      loki: { available: false },
      services: [],
    };

    const result = getMetricNames(caps);
    expect(result.callsMetric).toBe('traces_span_metrics_calls_total');
    expect(result.durationUnit).toBe('ms');
  });
});
