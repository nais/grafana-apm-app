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

/**
 * Base pipeline for extracting a vital from Faro measurement logs.
 * Filters to web-vitals measurements, requires the vital field to be non-empty,
 * applies browser filter, and keeps only the specified fields.
 */
export function lokiVitalPipeline(
  service: string,
  vital: string,
  extraKeep?: string,
  browserFilter = BROWSER_FILTER
): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"}`;
  const keepFields = extraKeep ? `${vital}, ${extraKeep}` : vital;
  return `${stream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" | ${vital}!="" ${browserFilter} | keep ${keepFields}`;
}

/** Weighted mean of a vital across all log entries (sum of values / count of entries). */
export function lokiVitalExpr(service: string, vital: string, window: string): string {
  const pipeline = lokiVitalPipeline(service, vital);
  return `sum(sum_over_time(${pipeline} | unwrap ${vital} ${window})) / sum(count_over_time(${pipeline} ${window}))`;
}

/** Weighted mean of a vital grouped by a label (e.g., browser_name). */
export function lokiVitalByGroupExpr(service: string, vital: string, groupBy: string, window: string): string {
  const pipeline = lokiVitalPipeline(service, vital, groupBy);
  return `sum by (${groupBy}) (sum_over_time(${pipeline} | unwrap ${vital} ${window})) / sum by (${groupBy}) (count_over_time(${pipeline} ${window}))`;
}

/** Weighted mean of a vital grouped by page URL, limited to top pages by volume. */
export function lokiVitalByPageExpr(
  service: string,
  vital: string,
  pageLabel: string,
  window: string,
  browserFilter = BROWSER_FILTER
): string {
  const pipeline = lokiVitalPipeline(service, vital, pageLabel, browserFilter);
  // Use topk to limit cardinality — only compute averages for the top 20 pages by volume
  return `topk(20, sum by (${pageLabel}) (sum_over_time(${pipeline} | unwrap ${vital} ${window})) / sum by (${pageLabel}) (count_over_time(${pipeline} ${window})))`;
}

/** Total exception count over time (for timeseries). */
export function lokiExceptionExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"}`;
  return `sum(count_over_time(${stream} | logfmt ${BROWSER_FILTER} ${window}))`;
}

/** Top exceptions ranked by occurrence count. */
export function lokiTopExceptionsExpr(service: string, window: string, browserFilter = BROWSER_FILTER): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"}`;
  return `topk(20, sum by (value) (count_over_time(${stream} | logfmt | value!="" ${browserFilter} | keep value ${window})))`;
}

/** Top exceptions ranked by number of unique sessions affected. */
export function lokiExceptionSessionsExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"}`;
  // Count distinct sessions: group by (value, session_id) to deduplicate, then count by value
  return `topk(20, count by (value) (count_over_time(${stream} | logfmt | value!="" | session_id!="" ${BROWSER_FILTER} | keep value, session_id ${window})))`;
}

/** Session start events over time. */
export function lokiSessionStartExpr(service: string, window: string, browserFilter = BROWSER_FILTER): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindEvent}"}`;
  return `sum(count_over_time(${stream} | logfmt | event_name="session_start" ${browserFilter} ${window}))`;
}

/** Top console.error messages ranked by count. */
export function lokiConsoleErrorsExpr(service: string, window: string, browserFilter = BROWSER_FILTER): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindLog}"}`;
  return `topk(10, sum by (value) (count_over_time(${stream} | logfmt | level="error" | value!="" ${browserFilter} | keep value ${window})))`;
}

/** Total web-vitals measurement count over time. */
export function lokiMeasurementCountExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"}`;
  return `sum(count_over_time(${stream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" ${BROWSER_FILTER} ${window}))`;
}

/** Rating distribution (good/needs-improvement/poor) count by rating label. */
export function lokiRatingExpr(service: string, window: string, browserFilter = BROWSER_FILTER): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"}`;
  return `sum by (${fl.rating}) (count_over_time(${stream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" | ${fl.rating}!="" ${browserFilter} | keep ${fl.rating} ${window}))`;
}
