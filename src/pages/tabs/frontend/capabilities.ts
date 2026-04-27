import { FrontendMetricsResponse } from '../../../api/client';

/**
 * Resolved capabilities for the frontend dashboard.
 * Determines which sections to render.
 */
export interface FrontendCapabilities {
  /** Whether any frontend telemetry data is available (metrics in Mimir). */
  available: boolean;
  /** Whether Loki has enrichment data (per-page, error messages, sessions). */
  hasLoki: boolean;
  /** Pre-computed p75 vitals from the backend (for bullet charts). */
  vitals?: Record<string, number>;
  /** Current error rate. */
  errorRate: number;
}

/**
 * Resolve frontend capabilities from the backend detection response.
 */
export function resolveCapabilities(response: FrontendMetricsResponse): FrontendCapabilities {
  if (!response.available) {
    return {
      available: false,
      hasLoki: false,
      errorRate: response.errorRate ?? 0,
    };
  }

  return {
    available: true,
    hasLoki: response.hasLoki ?? false,
    vitals: response.vitals,
    errorRate: response.errorRate ?? 0,
  };
}
