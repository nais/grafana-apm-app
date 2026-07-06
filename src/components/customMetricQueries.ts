import { CustomMetric } from '../api/client';

/**
 * Type-aware PromQL for auto-charting discovered custom metrics (#68 Phase 1).
 *
 * The backend infers the metric type (fixing the real-fleet mistypes: _total-less
 * counters, and Micrometer summaries/timers that Phase 0 split into gauge rows)
 * and hands down a `chart` hint. This module turns that hint into the actual
 * queries, so the auto-charted Scenes panels and the "Open in Explore" deep
 * links stay in lock-step.
 *
 * Query shapes by type:
 *   - counter  → sum(rate(X[$__rate_interval]))
 *   - histogram→ histogram_quantile(0.95, sum by(le)(rate(X_bucket[…])))
 *   - summary  → throughput sum(rate(X_count[…])) AND avg sum(rate(X_sum[…]))/sum(rate(X_count[…]))
 *                (never quantile — a summary/timer has no buckets)
 *   - gauge    → avg(X) — aggregated across pods so N pod series collapse to one line
 */

/** Grafana's built-in that adapts the range vector to the panel resolution. */
const RATE_INTERVAL = '$__rate_interval';

export interface CustomMetricQuery {
  refId: string;
  expr: string;
  legendFormat: string;
}

export interface CustomMetricPanelSpec {
  /** Panel title. */
  title: string;
  /** Grafana unit id, when the family's unit maps to one; undefined → short. */
  unit?: string;
  queries: CustomMetricQuery[];
}

/** Map a discovered unit name to a Grafana unit id (undefined → no override). */
function grafanaUnit(unit: string): string | undefined {
  switch (unit) {
    case 'seconds':
      return 's';
    case 'milliseconds':
      return 'ms';
    case 'bytes':
      return 'bytes';
    default:
      return undefined;
  }
}

/**
 * Build the auto-chart panel spec(s) for one family. Summaries/timers yield two
 * panels (throughput and average) because their units differ; every other type
 * yields a single panel.
 */
export function customMetricPanels(metric: CustomMetric, filter: string): CustomMetricPanelSpec[] {
  const n = metric.name;
  const unit = grafanaUnit(metric.unit);

  switch (metric.chart) {
    case 'rate':
      return [
        {
          title: n,
          queries: [{ refId: 'A', expr: `sum(rate(${n}{${filter}}[${RATE_INTERVAL}]))`, legendFormat: 'rate' }],
        },
      ];
    case 'p95':
      return [
        {
          title: `${n} · p95`,
          unit,
          queries: [
            {
              refId: 'A',
              expr: `histogram_quantile(0.95, sum by (le) (rate(${n}_bucket{${filter}}[${RATE_INTERVAL}])))`,
              legendFormat: 'p95',
            },
          ],
        },
      ];
    case 'summary':
      return [
        {
          title: `${n} · throughput`,
          queries: [
            { refId: 'A', expr: `sum(rate(${n}_count{${filter}}[${RATE_INTERVAL}]))`, legendFormat: 'throughput' },
          ],
        },
        {
          title: `${n} · avg`,
          unit,
          queries: [
            {
              refId: 'A',
              expr: `sum(rate(${n}_sum{${filter}}[${RATE_INTERVAL}])) / sum(rate(${n}_count{${filter}}[${RATE_INTERVAL}]))`,
              legendFormat: 'avg',
            },
          ],
        },
      ];
    case 'gauge':
    default:
      // Gauge labels include pod/instance; avg() collapses the N pod series into
      // one line instead of N overlapping ones.
      return [{ title: n, unit, queries: [{ refId: 'A', expr: `avg(${n}{${filter}})`, legendFormat: 'avg' }] }];
  }
}

/**
 * The single representative PromQL for a family's "Open in Explore" deep link —
 * the first auto-chart query, so the table link matches what the panel shows.
 */
export function customMetricExploreQuery(metric: CustomMetric, filter: string): string {
  return customMetricPanels(metric, filter)[0].queries[0].expr;
}
