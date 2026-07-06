import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import pluginJson from '../plugin.json';

// Log-pattern and trace-breakdown analytics. The fetch/param helpers mirror
// client.ts (they are module-private there); kept local to avoid widening
// client.ts's exported surface.

const BASE_URL = `/api/plugins/${pluginJson.id}/resources`;

/** Encode namespace for URL path segments, using '_' as placeholder for empty. */
function nsParam(namespace: string): string {
  return encodeURIComponent(namespace || '_');
}

async function fetchResource<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = params ? `${BASE_URL}${path}?${new URLSearchParams(params).toString()}` : `${BASE_URL}${path}`;
  const response = await lastValueFrom(getBackendSrv().fetch<T>({ url, method: 'GET' }));
  return response.data;
}

/** Convert millisecond timestamps to the seconds-based params the backend expects. */
function timeParams(from: number, to: number): Record<string, string> {
  return { from: String(Math.floor(from / 1000)), to: String(Math.floor(to / 1000)) };
}

// ---- Log patterns ----

export type LogPatternsMode = 'serverPatterns' | 'sampled' | 'unavailable';

export interface LogPattern {
  /** Clustered template (server mode) or normalized message title (sampled mode). */
  pattern: string;
  level: string;
  count: number;
  /** Representative raw line — sampled mode only; empty for server mode. */
  sample: string;
  firstSeenMs: number;
  lastSeenMs: number;
  /** Only appeared in the current window, not the preceding one (server mode). */
  isNew: boolean;
  /** Longest stable token — seeds the log search filter on click. */
  filterLiteral: string;
}

export interface LogPatternsResponse {
  mode: LogPatternsMode;
  patterns: LogPattern[];
  note?: string;
}

export async function getLogPatterns(
  namespace: string,
  service: string,
  from: number,
  to: number,
  lokiUid: string
): Promise<LogPatternsResponse> {
  return fetchResource<LogPatternsResponse>(
    `/services/${nsParam(namespace)}/${encodeURIComponent(service)}/logs/patterns`,
    {
      ...timeParams(from, to),
      lokiUid,
    }
  );
}

// ---- Trace breakdown ----

export type TraceBreakdownMode = 'traceql' | 'spanmetrics' | 'unavailable';

export interface TraceBreakdownRow {
  value: string;
  rate: number;
  errorRate: number;
  p95Ms: number;
  p99Ms: number;
}

export interface TraceBreakdownResponse {
  mode: TraceBreakdownMode;
  dimension: string;
  /** Group-by dimensions that carry data for this service. */
  dimensions: string[];
  rows: TraceBreakdownRow[];
  note?: string;
}

export async function getTraceBreakdown(
  namespace: string,
  service: string,
  from: number,
  to: number,
  tracesUid: string,
  dimension: string
): Promise<TraceBreakdownResponse> {
  return fetchResource<TraceBreakdownResponse>(
    `/services/${nsParam(namespace)}/${encodeURIComponent(service)}/traces/breakdown`,
    {
      ...timeParams(from, to),
      tracesUid,
      dimension,
    }
  );
}

// ---- Top database queries (issue #119 Phase 2) ----

export type TopQueriesMode = 'traceql' | 'unavailable';

export interface TopQuery {
  /** Normalized statement fingerprint — never a raw literal (PII-safe). */
  statement: string;
  dbSystem: string;
  /** db.sql.table when the driver populates it; often empty. */
  table?: string;
  count: number;
  totalTimeMs: number;
  avgTimeMs: number;
  p95Ms: number;
  /** Representative trace containing this query (for the drill-down link). */
  traceId?: string;
}

export interface TopQueriesResponse {
  mode: TopQueriesMode;
  queries: TopQuery[];
  /** Number of DB spans the aggregation sampled. */
  sampled: number;
  /** True when the trace-scan limit was hit (results are a bounded sample). */
  truncated: boolean;
  /** Effective (possibly clamped) window queried, in seconds. */
  windowSeconds: number;
  note?: string;
}

/**
 * Top normalized DB statements for a service, aggregated from a bounded,
 * cached Tempo trace search on the backend. On-demand only (load on section
 * open) — the backend owns the Tempo cost bounds and the cache.
 */
export async function getTopQueries(
  namespace: string,
  service: string,
  from: number,
  to: number,
  tracesUid: string
): Promise<TopQueriesResponse> {
  return fetchResource<TopQueriesResponse>(
    `/services/${nsParam(namespace)}/${encodeURIComponent(service)}/database/queries`,
    {
      ...timeParams(from, to),
      tracesUid,
    }
  );
}
