import { useEffect, useState } from 'react';
import { getCapabilities, Capabilities } from '../api/client';

let cachedCapabilities: Capabilities | null = null;
let fetchPromise: Promise<Capabilities> | null = null;

/**
 * Hook that fetches and caches plugin capabilities (detected metric names,
 * datasource availability, etc). The cache is module-scoped so all components
 * share the same result without redundant requests.
 */
export function useCapabilities(): { caps: Capabilities | null; loading: boolean } {
  const [caps, setCaps] = useState<Capabilities | null>(cachedCapabilities);
  const [loading, setLoading] = useState(cachedCapabilities === null);

  useEffect(() => {
    if (cachedCapabilities) {
      setCaps(cachedCapabilities);
      setLoading(false);
      return;
    }

    if (!fetchPromise) {
      fetchPromise = getCapabilities().then((result) => {
        cachedCapabilities = result;
        return result;
      });
    }

    fetchPromise
      .then((result) => {
        setCaps(result);
      })
      .catch(() => {
        // Capabilities unavailable — features will degrade gracefully
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return { caps, loading };
}

/**
 * Returns the calls metric name and duration bucket metric name
 * from capabilities, or sensible defaults.
 */
export function getMetricNames(caps: Capabilities | null) {
  const callsMetric = caps?.spanMetrics?.callsMetric || 'traces_span_metrics_calls_total';
  const namespace = caps?.spanMetrics?.namespace || 'traces_span_metrics';
  const durationUnit = caps?.spanMetrics?.durationUnit || 'ms';

  let durationBucket: string;
  if (durationUnit === 'ms') {
    durationBucket = namespace + '_duration_milliseconds_bucket';
  } else {
    durationBucket = namespace + '_duration_seconds_bucket';
  }

  return { callsMetric, durationBucket, durationUnit, namespace };
}
