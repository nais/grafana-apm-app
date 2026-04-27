import { FrontendMetricsResponse } from '../../../api/client';

/** The metrics engine powering vital measurements. */
export type MetricsEngine = 'mimir' | 'alloy-histogram' | 'alloy' | null;

/** The logs engine powering page-level and error data. */
export type LogsEngine = 'loki' | null;

/** Features available based on detected capabilities. */
export type FrontendFeature =
  | 'cwvBullets'
  | 'cwvTrends'
  | 'cwvRatingBreakdown'
  | 'navType'
  | 'browserVolume'
  | 'perPage'
  | 'exceptions'
  | 'consoleErrors'
  | 'sessions'
  | 'trafficTimeseries';

/**
 * Resolved capabilities for the frontend dashboard.
 * Determines which sections to render and which query adapter to use.
 */
export interface FrontendCapabilities {
  /** Whether any frontend telemetry data is available. */
  available: boolean;
  /** The primary metrics source for vital measurements. */
  metricsEngine: MetricsEngine;
  /** Whether Loki logs are available for page-level and error data. */
  logsEngine: LogsEngine;
  /** Set of features that can be rendered given the detected capabilities. */
  features: Set<FrontendFeature>;
  /** Pre-computed p75 vitals from the backend (for bullet charts). */
  vitals?: Record<string, number>;
  /** Current error rate. */
  errorRate: number;
}

/**
 * Resolve frontend capabilities from the backend detection response.
 *
 * This is the single source of truth for "what can we show?" — it replaces
 * the scattered source-checking logic throughout the dashboard components.
 */
export function resolveCapabilities(response: FrontendMetricsResponse): FrontendCapabilities {
  const metricsEngine = (response.source as MetricsEngine) ?? null;
  const logsEngine: LogsEngine = response.hasLoki ? 'loki' : null;
  const features = new Set<FrontendFeature>();

  if (!response.available || !metricsEngine) {
    return {
      available: false,
      metricsEngine: null,
      logsEngine: null,
      features,
      errorRate: response.errorRate ?? 0,
    };
  }

  // Bullet charts: available for any metrics engine with vitals data
  if (response.vitals && Object.keys(response.vitals).length > 0) {
    features.add('cwvBullets');
  }

  // CWV trends: always available when we have a metrics source
  features.add('cwvTrends');

  // Histogram-specific features
  if (metricsEngine === 'alloy-histogram') {
    features.add('cwvRatingBreakdown');
    features.add('navType');
    features.add('browserVolume');
  }

  // Traffic timeseries from counters (histogram) or Loki count
  features.add('trafficTimeseries');

  // Loki-specific features
  if (logsEngine === 'loki') {
    features.add('perPage');
    features.add('exceptions');
    features.add('consoleErrors');
    features.add('sessions');
  }

  return {
    available: true,
    metricsEngine,
    logsEngine,
    features,
    vitals: response.vitals,
    errorRate: response.errorRate ?? 0,
  };
}
