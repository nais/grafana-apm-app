import { getMetricNames } from './capabilities';
import { Capabilities } from '../api/client';

describe('getMetricNames', () => {
  it('returns defaults when caps is null', () => {
    const result = getMetricNames(null);
    expect(result.callsMetric).toBe('traces_span_metrics_calls_total');
    expect(result.durationBucket).toBe('traces_span_metrics_duration_milliseconds_bucket');
    expect(result.durationUnit).toBe('ms');
    expect(result.namespace).toBe('traces_span_metrics');
  });

  it('uses detected span metrics', () => {
    const caps: Capabilities = {
      spanMetrics: {
        detected: true,
        namespace: 'my_app_metrics',
        callsMetric: 'my_app_metrics_calls_total',
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
    expect(result.namespace).toBe('my_app_metrics');
  });

  it('uses ms bucket for ms duration unit', () => {
    const caps: Capabilities = {
      spanMetrics: {
        detected: true,
        namespace: 'spans',
        callsMetric: 'spans_calls_total',
        durationUnit: 'ms',
      },
      serviceGraph: { detected: true },
      tempo: { available: true },
      loki: { available: true },
      services: ['frontend', 'backend'],
    };

    const result = getMetricNames(caps);
    expect(result.durationBucket).toBe('spans_duration_milliseconds_bucket');
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
