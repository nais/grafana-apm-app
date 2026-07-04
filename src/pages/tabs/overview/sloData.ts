/**
 * SLO / error-budget data layer for the Overview panel (M7).
 *
 * Grafana's managed SLO product is Cloud-only, so this is the OSS-niche
 * equivalent computed straight off the RED error ratio from span metrics. The
 * numbers are derived entirely client-side from three cheap instant queries:
 *
 *   - errorRatio30d : compliance + remaining error budget
 *   - total30d      : data-sufficiency guard (a 99.9% target is meaningless
 *                     over a handful of requests)
 *   - errorRatio1h  : the current burn rate, as a multiple of the budget
 *
 * The SLO *target* only scales the budget divisor, so the queries do NOT depend
 * on it — changing the target selector re-computes instantly with no refetch.
 *
 * We query Mimir directly through Grafana's datasource-proxy resource route
 * (`/api/datasources/uid/<uid>/resources/api/v1/query`) rather than adding a
 * backend endpoint: the compliance window (fixed 30d) is independent of the
 * page time picker, so the existing `/health` summary (which follows the
 * picker) can't supply it, and a Scenes panel can't surface three scalars as a
 * budget bar + burn multiple. An instant query is the smallest honest tool.
 */

import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { otel } from '../../../otelconfig';
import { sanitizeLabelValue } from '../../../utils/sanitize';
import pluginJson from '../../../plugin.json';

/** Selectable SLO targets, matching the panel's RadioButtonGroup. */
export const SLO_TARGETS = [0.99, 0.995, 0.999, 0.9999] as const;
export const DEFAULT_SLO_TARGET = 0.999;

/**
 * Minimum total requests over 30d for a compliance ratio to be meaningful. Even
 * a 99% target needs ~100 requests before a single error moves the number, so
 * 1000 is a conservative floor below which we degrade to "not enough data".
 */
export const MIN_SLO_SAMPLES = 1000;

export interface SloRawMetrics {
  /** Error ratio over 30d (0..1), or null when the window has no traffic. */
  errorRatio30d: number | null;
  /** Total requests over 30d, for the data-sufficiency guard. */
  total30d: number | null;
  /** Error ratio over the trailing 1h (0..1), or null when 1h has no traffic. */
  errorRatio1h: number | null;
}

export type SloStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export interface SloComputed {
  /** False when the 30d window has too little traffic for a meaningful ratio. */
  enoughData: boolean;
  /** 30d compliance as a percentage (e.g. 99.97), or null when not enough data. */
  compliancePct: number | null;
  /** Remaining error budget as a percentage; may be negative when overspent. */
  budgetRemainingPct: number | null;
  /** Current burn rate over 1h as a multiple of the budget, or null. */
  burnRate1h: number | null;
  /** Traffic-light status derived from the remaining budget. */
  status: SloStatus;
}

/**
 * Build the PromQL label selector for a service, mirroring buildServiceScene's
 * svcFilter (service_name [+ service_namespace] [+ deployment env]). Multiple
 * comma-separated environments become a regex matcher, like the backend's
 * envMatcher.
 */
export function sloSelector(service: string, namespace: string, environment?: string): string {
  let sel = `${otel.labels.serviceName}="${sanitizeLabelValue(service)}"`;
  if (namespace) {
    sel += `, ${otel.labels.serviceNamespace}="${sanitizeLabelValue(namespace)}"`;
  }
  if (environment) {
    const envs = environment
      .split(',')
      .map((e) => sanitizeLabelValue(e.trim()))
      .filter(Boolean);
    if (envs.length === 1) {
      sel += `, ${otel.labels.deploymentEnv}="${envs[0]}"`;
    } else if (envs.length > 1) {
      sel += `, ${otel.labels.deploymentEnv}=~"${envs.join('|')}"`;
    }
  }
  return sel;
}

/** Error ratio over `window`; `or vector(0)` keeps a zero-error window a real 0. */
function errorRatioExpr(calls: string, selector: string, window: string): string {
  const err = `${selector}, ${otel.labels.statusCode}="${otel.statusCodes.error}"`;
  return `(sum(rate(${calls}{${err}}[${window}])) or vector(0)) / sum(rate(${calls}{${selector}}[${window}]))`;
}

interface PromVectorResponse {
  data?: { result?: Array<{ value?: [number, string] }> };
}

/**
 * Run one Prometheus instant query through the datasource proxy and return the
 * scalar value, or null when the result is empty / non-numeric.
 */
export async function promInstant(uid: string, query: string, timeSec: number): Promise<number | null> {
  const params = new URLSearchParams({ query, time: String(timeSec) });
  const resp = await lastValueFrom(
    getBackendSrv().fetch<PromVectorResponse>({
      url: `/api/datasources/uid/${encodeURIComponent(uid)}/resources/api/v1/query?${params.toString()}`,
      method: 'GET',
    })
  );
  const raw = resp.data?.data?.result?.[0]?.value?.[1];
  if (raw === undefined) {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Fetch the three raw metrics the panel needs (compliance, sufficiency, burn). */
export async function fetchSloMetrics(uid: string, calls: string, selector: string): Promise<SloRawMetrics> {
  const nowSec = Math.floor(Date.now() / 1000);
  const [errorRatio30d, total30d, errorRatio1h] = await Promise.all([
    promInstant(uid, errorRatioExpr(calls, selector, '30d'), nowSec),
    promInstant(uid, `sum(increase(${calls}{${selector}}[30d]))`, nowSec),
    promInstant(uid, errorRatioExpr(calls, selector, '1h'), nowSec),
  ]);
  return { errorRatio30d, total30d, errorRatio1h };
}

/**
 * Derive compliance, remaining budget, burn rate and status from the raw
 * metrics for a given SLO target. Pure — the whole target selector is just a
 * re-run of this function.
 */
export function computeSlo(raw: SloRawMetrics, target: number): SloComputed {
  const budget = 1 - target;
  const burnRate1h = raw.errorRatio1h === null || budget <= 0 ? null : raw.errorRatio1h / budget;

  const enoughData =
    raw.errorRatio30d !== null && raw.total30d !== null && raw.total30d >= MIN_SLO_SAMPLES && budget > 0;

  if (!enoughData) {
    return { enoughData: false, compliancePct: null, budgetRemainingPct: null, burnRate1h, status: 'unknown' };
  }

  const errorRatio = raw.errorRatio30d as number;
  const compliancePct = (1 - errorRatio) * 100;
  const consumed = errorRatio / budget; // fraction of the budget spent
  const budgetRemainingPct = (1 - consumed) * 100;

  const status: SloStatus = budgetRemainingPct > 50 ? 'healthy' : budgetRemainingPct > 20 ? 'warning' : 'critical';

  return { enoughData: true, compliancePct, budgetRemainingPct, burnRate1h, status };
}

/** Format an SLO target fraction as its percentage label ("99.9%"). */
export function formatSloTarget(target: number): string {
  const pct = Math.round(target * 1e7) / 1e5;
  return `${pct}%`;
}

export type BurnWindow = 'fast' | 'slow';

/**
 * Fetch the server-rendered burn-rate alert template URL for one window/tier.
 * Uses the same `/alert-templates/<kind>` resource as the other templates (the
 * query shape, detected calls metric and datasource UID all stay server-side);
 * the caller appends returnTo via buildAlertRuleUrl before navigating.
 */
export async function fetchSloBurnTemplateUrl(opts: {
  namespace?: string;
  service: string;
  environment?: string;
  target: number;
  window: BurnWindow;
}): Promise<string> {
  const params = new URLSearchParams({
    service: opts.service,
    window: opts.window,
    slo: String(opts.target),
  });
  if (opts.namespace) {
    params.set('namespace', opts.namespace);
  }
  if (opts.environment) {
    params.set('environment', opts.environment);
  }
  const resp = await lastValueFrom(
    getBackendSrv().fetch<{ url: string }>({
      url: `/api/plugins/${pluginJson.id}/resources/alert-templates/slo-burn-rate?${params.toString()}`,
      method: 'GET',
    })
  );
  return resp.data.url;
}
