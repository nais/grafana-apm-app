import { DsRef } from './panel-helpers';

/**
 * Shared context passed to all section builders.
 *
 * The Mimir pipeline is the canonical source for all frontend telemetry.
 * Loki provides enrichment (per-page breakdowns, full error messages,
 * console logs, sessions) but is not required for the core dashboard.
 */
export interface FrontendSceneContext {
  /** Prometheus datasource for Mimir histogram queries. */
  metricsDs: DsRef;
  /** Loki datasource for log-based enrichment queries. */
  logsDs: DsRef;
  /** Service name (already sanitized for label values). */
  service: string;
  /** Namespace for URL construction. */
  namespace: string;
  /** Environment (for datasource selection and filtering). */
  environment?: string;
  /** Pre-computed PromQL label filter for histogram queries. */
  svcFilter: string;
  /** Whether Loki has data for this service (enables enrichment panels). */
  hasLoki: boolean;
  /** Alloy histogram config reference. */
  ah: typeof import('../../../otelconfig').otel.alloyHistogram;
}
