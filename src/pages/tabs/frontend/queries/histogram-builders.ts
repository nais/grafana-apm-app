/**
 * PromQL query builders for Alloy histogram-based Faro metrics.
 *
 * These build queries against the `loki_process_custom_faro_*` metrics produced
 * by the Alloy pipeline's `stage.metrics` histogram/counter extractors.
 */
import { otel } from '../../../../otelconfig';
import { CWV_BUCKET_BOUNDARIES, VitalKey } from '../constants';

const ah = otel.alloyHistogram;

/**
 * Build the label filter string for histogram queries.
 * Always includes app_name and job; optionally includes env.
 */
export function histogramFilter(service: string, environment?: string): string {
  const base = `${ah.appLabel}="${service}", job="${ah.job}"`;
  return environment ? `${base}, ${ah.envLabel}="${environment}"` : base;
}

/** P75 quantile of a vital histogram (for trends timeseries). */
export function histogramVitalTrend(vital: VitalKey, filter: string): string {
  const metric = ah[vital];
  return `histogram_quantile(0.75, sum(rate(${metric}_bucket{${filter}}[$__rate_interval])) by (le))`;
}

/** P75 quantile over a fixed window (for instant/stat queries). */
export function histogramVitalInstant(vital: VitalKey, filter: string, window = '6h'): string {
  const metric = ah[vital];
  return `histogram_quantile(0.75, sum(increase(${metric}_bucket{${filter}}[${window}])) by (le))`;
}

/**
 * CWV rating percentage queries for a single vital.
 * Returns { good, needsImprovement, poor } PromQL expressions that each yield a 0-1 ratio.
 */
export function cwvRatingExprs(vital: VitalKey, filter: string): { good: string; ni: string; poor: string } {
  const metric = ah[vital];
  const { good, poor } = CWV_BUCKET_BOUNDARIES[vital];

  const goodExpr = `increase(${metric}_bucket{${filter}, le="${good}"}[$__range]) / increase(${metric}_bucket{${filter}, le="+Inf"}[$__range])`;
  const niExpr = `(increase(${metric}_bucket{${filter}, le="${poor}"}[$__range]) - increase(${metric}_bucket{${filter}, le="${good}"}[$__range])) / increase(${metric}_bucket{${filter}, le="+Inf"}[$__range])`;
  const poorExpr = `1 - increase(${metric}_bucket{${filter}, le="${poor}"}[$__range]) / increase(${metric}_bucket{${filter}, le="+Inf"}[$__range])`;

  return { good: goodExpr, ni: niExpr, poor: poorExpr };
}

/** Navigation type distribution (for 100% stacked timeseries). */
export function navTypeRateExpr(filter: string): string {
  return `sum by (${ah.navTypeLabel}) (rate(${ah.pageLoadsByNav}{${filter}}[$__rate_interval]))`;
}

/** Page load measurements rate. */
export function pageLoadsRateExpr(filter: string): string {
  return `sum(rate(${ah.pageLoads}{${filter}}[$__rate_interval]))`;
}

/** Error count rate. */
export function errorsRateExpr(filter: string): string {
  return `sum(rate(${ah.errors}{${filter}}[$__rate_interval]))`;
}

/** Browser volume breakdown (for pie/table). */
export function browserVolumeExpr(filter: string): string {
  return `sum by (${ah.browserLabel}) (increase(${ah.pageLoads}{${filter}, ${ah.browserLabel}!=""}[$__range]))`;
}
