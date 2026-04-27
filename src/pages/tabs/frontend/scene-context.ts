import { DsRef } from './panel-helpers';

/**
 * Shared context passed to all section builders.
 * Replaces scattered parameter passing throughout the scene construction.
 */
export interface FrontendSceneContext {
  /** Prometheus datasource for Mimir/histogram queries. */
  metricsDs: DsRef;
  /** Loki datasource for log-based queries. */
  logsDs: DsRef;
  /** Service name (already sanitized for label values). */
  service: string;
  /** Namespace for URL construction. */
  namespace: string;
  /** Environment (for datasource selection and filtering). */
  environment?: string;
  /** Pre-computed PromQL label filter for histogram queries (empty string for non-histogram). */
  svcFilter: string;
  /** Whether the source is alloy-histogram (enables histogram-specific features). */
  isHistogram: boolean;
  /** Whether Loki is available for log-based panels. */
  showLokiPanels: boolean;
  /** Alloy histogram config reference. */
  ah: typeof import('../../../otelconfig').otel.alloyHistogram;
}
