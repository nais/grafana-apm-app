import { SceneQueryRunner } from '@grafana/scenes';

import { VitalKey } from './constants';

/**
 * Adapter interface that abstracts query construction for the Frontend tab.
 *
 * Each method returns a SceneQueryRunner configured for the underlying
 * data source (Mimir histograms, Loki logs, or Alloy counters).
 * Section builders consume this interface to build panels without
 * knowing which backend is in use.
 */
export interface FrontendQueryAdapter {
  /** Identifier for the data source type. */
  readonly sourceType: 'alloy-histogram' | 'loki' | 'mimir' | 'alloy';

  /** Label describing the aggregation method (e.g., 'p75' for histogram, 'avg' for loki). */
  readonly trendLabel: string;

  // --- Core Web Vitals trends ---

  /** Combined page-load vitals (TTFB + FCP + LCP) as a multi-query timeseries. */
  getPageLoadVitalsTrend(): SceneQueryRunner;

  /** Single-vital trend timeseries (for INP, CLS standalone panels). */
  getVitalTrend(vital: VitalKey): SceneQueryRunner;

  // --- Traffic & volume ---

  /** Measurement rate over time (page loads per interval). */
  getMeasurementRate(): SceneQueryRunner;

  /** Error/exception rate over time. */
  getErrorRate(): SceneQueryRunner;

  /** Session start rate over time (always Loki). */
  getSessionRate?(): SceneQueryRunner;

  // --- Histogram-specific (optional) ---

  /** CWV rating breakdown queries (good/needs-improvement/poor per vital). */
  getCwvRatingBreakdown?(): SceneQueryRunner;

  /** Navigation type distribution (navigate/reload/back_forward). */
  getNavTypeDistribution?(): SceneQueryRunner;

  /** Browser volume breakdown (page loads by browser_name). */
  getBrowserVolume?(): SceneQueryRunner;

  // --- Loki-specific (optional) ---

  /** Per-page performance table (requires page_url from logs). */
  getPerPageTable?(): SceneQueryRunner;

  /** Top exceptions ranked by count and session impact. */
  getTopExceptions?(): SceneQueryRunner;

  /** Console error messages. */
  getConsoleErrors?(): SceneQueryRunner;

  /** Browser breakdown (vitals by browser_name). */
  getBrowserBreakdown?(): SceneQueryRunner;

  /** Rating distribution pie (good/needs-improvement/poor from rating label). */
  getRatingDistribution?(): SceneQueryRunner;
}
