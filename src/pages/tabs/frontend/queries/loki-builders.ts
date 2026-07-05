/**
 * LogQL query builders for Faro telemetry stored as structured logs in Loki.
 *
 * Each function produces a complete LogQL expression using the otel.faroLoki
 * field definitions. The queries assume logfmt-encoded log lines with fields
 * like: type, lcp, fcp, cls, inp, ttfb, browser_name, page_url, etc.
 */
import { otel } from '../../../../otelconfig';
import { sanitizeLabelValue } from '../../../../utils/sanitize';
import { BROWSER_FILTER } from '../constants';

/** Options for injecting a cluster/environment filter into Loki stream selectors. */
export interface LokiClusterOpts {
  /** Cluster name value (e.g., "prod-gcp") to filter on in centralized Loki. */
  cluster?: string;
  /** Label name for the cluster filter (defaults to otel.labels.deploymentEnv). */
  clusterLabel?: string;
}

/** Build the cluster stream matcher fragment, e.g. `, k8s_cluster_name="prod-gcp"` */
function clusterMatcher(opts?: LokiClusterOpts): string {
  if (!opts?.cluster) {
    return '';
  }
  const label = opts.clusterLabel || otel.labels.deploymentEnv;
  return `, ${label}="${sanitizeLabelValue(opts.cluster)}"`;
}

/**
 * Base pipeline for extracting a vital from Faro measurement logs.
 * Filters to web-vitals measurements, requires the vital field to be non-empty,
 * applies browser filter, and keeps only the specified fields.
 */
export function lokiVitalPipeline(
  service: string,
  vital: string,
  extraKeep?: string,
  browserFilter = BROWSER_FILTER,
  clusterOpts?: LokiClusterOpts
): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"${clusterMatcher(clusterOpts)}}`;
  const keepFields = extraKeep ? `${vital}, ${extraKeep}` : vital;
  return `${stream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" | ${vital}!="" ${browserFilter} | keep ${keepFields}`;
}

/**
 * p75 of a vital across all log entries via `quantile_over_time`.
 *
 * Core Web Vitals (LCP/FCP/CLS/INP/TTFB) are *defined* at the 75th percentile
 * ("good" thresholds are p75 cutoffs), so this matches both the published
 * definition and the Mimir `histogram_quantile(0.75, …)` panels the frontend
 * Scene already renders — a plain mean understates a right-skewed
 * distribution and doesn't correspond to any published threshold.
 */
export function lokiVitalExpr(service: string, vital: string, window: string, clusterOpts?: LokiClusterOpts): string {
  const pipeline = lokiVitalPipeline(service, vital, undefined, BROWSER_FILTER, clusterOpts);
  return `quantile_over_time(0.75, ${pipeline} | unwrap ${vital} ${window})`;
}

/** p75 of a vital grouped by a label (e.g., browser_name), matching the histogram panels. */
export function lokiVitalByGroupExpr(
  service: string,
  vital: string,
  groupBy: string,
  window: string,
  clusterOpts?: LokiClusterOpts
): string {
  const pipeline = lokiVitalPipeline(service, vital, groupBy, BROWSER_FILTER, clusterOpts);
  return `quantile_over_time(0.75, ${pipeline} | unwrap ${vital} ${window}) by (${groupBy})`;
}

/** p75 of a vital grouped by page URL, limited to top pages by volume, matching the histogram panels. */
export function lokiVitalByPageExpr(
  service: string,
  vital: string,
  pageLabel: string,
  window: string,
  browserFilter = BROWSER_FILTER,
  clusterOpts?: LokiClusterOpts
): string {
  const fl = otel.faroLoki;
  // Keep page_id alongside the page label so we can prefer it when available
  const pipeline = lokiVitalPipeline(service, vital, `${pageLabel}, ${fl.pageId}`, browserFilter, clusterOpts);
  // Prefer page_id (normalized route from generatePageId) over raw page_url.
  // When page_id is absent/empty, falls back to the original page label value.
  const labelFormat = `| label_format ${pageLabel}="{{if .${fl.pageId}}}{{.${fl.pageId}}}{{else}}{{.${pageLabel}}}{{end}}"`;
  // Use topk to limit cardinality — only compute p75s for the top 20 pages by volume
  return `topk(20, quantile_over_time(0.75, ${pipeline} ${labelFormat} | unwrap ${vital} ${window}) by (${pageLabel}))`;
}

/**
 * Base pipeline for web-vitals attribution breakdowns.
 *
 * Like lokiVitalPipeline but additionally requires the attribution context
 * field to be non-empty, so rows without attribution (older SDKs, vitals
 * without a target) are excluded before aggregation.
 *
 * Attribution field names (verified against @grafana/faro-web-sdk 2.8.2,
 * instrumentations/webVitals/webVitalsWithAttribution.ts; Alloy prefixes
 * measurement context entries with `context_` in logfmt):
 *   lcp → context_element, inp → context_interaction_target,
 *   cls → context_largest_shift_target
 */
export function lokiVitalAttributionPipeline(
  service: string,
  vital: string,
  attrField: string,
  browserFilter = BROWSER_FILTER,
  clusterOpts?: LokiClusterOpts
): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"${clusterMatcher(clusterOpts)}}`;
  return `${stream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" | ${vital}!="" | ${attrField}!="" ${browserFilter} | keep ${vital}, ${attrField}`;
}

/**
 * Average vital value per attribution target, limited to the top 8 targets.
 * e.g. "which LCP elements are slowest", "which interactions have worst INP".
 */
export function lokiVitalAttributionAvgExpr(
  service: string,
  vital: string,
  attrField: string,
  window: string,
  browserFilter = BROWSER_FILTER,
  clusterOpts?: LokiClusterOpts
): string {
  const pipeline = lokiVitalAttributionPipeline(service, vital, attrField, browserFilter, clusterOpts);
  return `topk(8, avg by (${attrField}) (avg_over_time(${pipeline} | unwrap ${vital} ${window})))`;
}

/**
 * Measurement count per attribution target, limited to the top 8 targets.
 * Companion to lokiVitalAttributionAvgExpr — shows how often each target
 * is responsible for the vital, so rare-but-slow outliers stand out.
 */
export function lokiVitalAttributionCountExpr(
  service: string,
  vital: string,
  attrField: string,
  window: string,
  browserFilter = BROWSER_FILTER,
  clusterOpts?: LokiClusterOpts
): string {
  const pipeline = lokiVitalAttributionPipeline(service, vital, attrField, browserFilter, clusterOpts);
  return `topk(8, sum by (${attrField}) (count_over_time(${pipeline} ${window})))`;
}

/** Total exception count over time (for timeseries). */
export function lokiExceptionExpr(service: string, window: string, clusterOpts?: LokiClusterOpts): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"${clusterMatcher(clusterOpts)}}`;
  return `sum(count_over_time(${stream} | logfmt ${BROWSER_FILTER} ${window}))`;
}

/** Top exceptions ranked by occurrence count. */
export function lokiTopExceptionsExpr(
  service: string,
  window: string,
  browserFilter = BROWSER_FILTER,
  clusterOpts?: LokiClusterOpts
): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"${clusterMatcher(clusterOpts)}}`;
  return `topk(20, sum by (${fl.hash}, value) (count_over_time(${stream} | logfmt | value!="" | ${fl.hash}!="" ${browserFilter} | keep value, ${fl.hash} ${window})))`;
}

/** Top exceptions ranked by number of unique sessions affected. */
export function lokiExceptionSessionsExpr(service: string, window: string, clusterOpts?: LokiClusterOpts): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"${clusterMatcher(clusterOpts)}}`;
  // Count distinct sessions: group by (hash, value, session_id) to deduplicate, then count by hash and value
  return `topk(20, count by (${fl.hash}, value) (count_over_time(${stream} | logfmt | value!="" | ${fl.hash}!="" | session_id!="" ${BROWSER_FILTER} | keep value, ${fl.hash}, session_id ${window})))`;
}

/** Session start events over time. */
export function lokiSessionStartExpr(
  service: string,
  window: string,
  browserFilter = BROWSER_FILTER,
  clusterOpts?: LokiClusterOpts
): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindEvent}"${clusterMatcher(clusterOpts)}}`;
  return `sum(count_over_time(${stream} | logfmt | event_name="session_start" ${browserFilter} ${window}))`;
}

/** Top console.error messages ranked by count. */
export function lokiConsoleErrorsExpr(
  service: string,
  window: string,
  browserFilter = BROWSER_FILTER,
  clusterOpts?: LokiClusterOpts
): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}=~"${fl.kindLog}|${fl.kindException}"${clusterMatcher(clusterOpts)}}`;
  return `topk(10, sum by (value) (count_over_time(${stream} | logfmt | (kind="log" and level="error") or (kind="exception" and (hash="" or value=~"(?i)console.error:.*")) | value!="" ${browserFilter} | keep value ${window})))`;
}

/** Total web-vitals measurement count over time. */
export function lokiMeasurementCountExpr(service: string, window: string, clusterOpts?: LokiClusterOpts): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"${clusterMatcher(clusterOpts)}}`;
  return `sum(count_over_time(${stream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" ${BROWSER_FILTER} ${window}))`;
}

/** Rating distribution (good/needs-improvement/poor) count by rating label. */
export function lokiRatingExpr(
  service: string,
  window: string,
  browserFilter = BROWSER_FILTER,
  clusterOpts?: LokiClusterOpts
): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"${clusterMatcher(clusterOpts)}}`;
  return `sum by (${fl.rating}) (count_over_time(${stream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" | ${fl.rating}!="" ${browserFilter} | keep ${fl.rating} ${window}))`;
}
