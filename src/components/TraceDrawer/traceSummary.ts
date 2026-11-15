import { DataFrame, Field, LoadingState, PanelData } from '@grafana/data';
import { escapeRegex } from '../../utils/debounce';
import { escapeQueryString } from '../../utils/sanitize';
import { fullTraceId } from './traceLinks';

/** What the drawer's header shows about a loaded trace. */
export interface TraceSummary {
  /** The root span's name, or the earliest span's when the root is missing (a partial trace). */
  rootName: string;
  rootService: string;
  /** Every service with a span in the trace, root service first. */
  services: string[];
  startMs: number;
  durationMs: number;
  spanCount: number;
  errorCount: number;
}

// OTel status code of a failed span, as Tempo's trace frame carries it.
const STATUS_ERROR = 2;

function field(frame: DataFrame, name: string): Field | undefined {
  return frame.fields.find((f) => f.name === name);
}

/**
 * Summarises the frame a Tempo trace-by-ID query returns (one row per span). Undefined until
 * the trace has loaded, or when the frame is not a trace.
 */
export function summarizeTrace(frame: DataFrame | undefined): TraceSummary | undefined {
  if (!frame || frame.length === 0) {
    return undefined;
  }
  const parents = field(frame, 'parentSpanID')?.values;
  const names = field(frame, 'operationName')?.values;
  const services = field(frame, 'serviceName')?.values;
  const starts = field(frame, 'startTime')?.values;
  const durations = field(frame, 'duration')?.values;
  const statuses = field(frame, 'statusCode')?.values;
  if (!names || !services || !starts || !durations) {
    return undefined;
  }

  let root = -1;
  let earliest = 0;
  let startMs = Infinity;
  let endMs = -Infinity;
  let errorCount = 0;
  for (let i = 0; i < frame.length; i++) {
    const start = Number(starts[i]);
    const end = start + Number(durations[i]);
    if (start < startMs) {
      startMs = start;
      earliest = i;
    }
    endMs = Math.max(endMs, end);
    if (root < 0 && !parents?.[i]) {
      root = i;
    }
    if (Number(statuses?.[i]) === STATUS_ERROR) {
      errorCount++;
    }
  }
  const head = root >= 0 ? root : earliest;
  const rootService = String(services[head] ?? '');
  const others = new Set<string>();
  for (let i = 0; i < frame.length; i++) {
    const name = String(services[i] ?? '');
    if (name && name !== rootService) {
      others.add(name);
    }
  }

  return {
    rootName: String(names[head] ?? ''),
    rootService,
    services: [rootService, ...[...others].sort()].filter(Boolean),
    startMs,
    durationMs: endMs - startMs,
    spanCount: frame.length,
    errorCount,
  };
}

/** Where a trace lookup stands: the drawer's message, and whether the Logs tab can run. */
export type TraceLookup =
  { status: 'loading' } | { status: 'found' } | { status: 'not-found' } | { status: 'error'; message: string };

// Grafana's Tempo datasource on a 404 from Tempo's trace-by-ID API: "failed to get trace with id:
// <id> Status: 404 Not Found Body: trace not found". A missing datasource or proxy route says
// "not found" too, but is a configuration error, not a missing trace.
const TEMPO_TRACE_MISS = /failed to get trace with id[\s\S]*\b404\b|\btrace not found\b/i;

/**
 * Tells a trace Tempo does not have (a successful empty answer, or Tempo's own 404) from a lookup
 * that failed (no access, network, a missing datasource, a Tempo error): the first is about the
 * trace, the second is not.
 */
export function traceLookup(data: PanelData | undefined): TraceLookup {
  if (data?.state === LoadingState.Error) {
    const message = data.errors?.[0]?.message ?? '';
    return TEMPO_TRACE_MISS.test(message) ? { status: 'not-found' } : { status: 'error', message };
  }
  if (data?.state === LoadingState.Done) {
    return data.series?.[0]?.length ? { status: 'found' } : { status: 'not-found' };
  }
  return { status: 'loading' };
}

interface TraceLogsOptions {
  /** Loki stream label naming the service. */
  serviceLabel: string;
  /** The services in the trace: only their streams are searched. */
  services: string[];
  /** For a Loki shared by environments: the label and the selected environments (comma-separated). */
  clusterLabel?: string;
  clusterFilter?: string;
}

/**
 * A label matcher for one value or any of several. Values are escaped, not filtered: an OTel
 * `service.name` may hold `+`, brackets or non-ASCII text, and dropping it would hide its logs.
 */
function labelMatcher(label: string, values: string[]): string {
  return values.length === 1
    ? `${label}="${escapeQueryString(values[0])}"`
    : `${label}=~"${values.map((v) => escapeQueryString(escapeRegex(v))).join('|')}"`;
}

/**
 * LogQL for the log lines of one trace, in the streams of the services in the trace. Two
 * queries, so a line is found however it carries the ID and never twice:
 * - the ID in the line itself (a JSON `trace_id`, or anywhere in plain text);
 * - the ID only in Loki's `trace_id` structured metadata, as OTLP logs carry it.
 * A 64-bit (B3) trace ID, whose padded form starts with 16 zeros, may be logged as its 16 low
 * characters, so both queries look for that form too. Lines from more than one service start
 * with the service's name. Empty without a service.
 */
export function buildTraceLogsQueries(traceId: string, opts: TraceLogsOptions): string[] {
  const services = [...new Set(opts.services.filter(Boolean))];
  if (services.length === 0) {
    return [];
  }
  const environments = (opts.clusterFilter ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const clusterMatcher =
    environments.length > 0 && opts.clusterLabel ? `, ${labelMatcher(opts.clusterLabel, environments)}` : '';
  const selector = `{${labelMatcher(opts.serviceLabel, services)}${clusterMatcher}}`;
  // Validated hex by the drawer; the short form is a substring of the padded one, so one line
  // filter catches both.
  const full = fullTraceId(traceId);
  const isB3 = full.startsWith('0'.repeat(16));
  const needle = isB3 ? full.slice(16) : full;
  const metadata = isB3 ? `trace_id=~"(0{16})?${needle}"` : `trace_id="${full}"`;
  const message = '{{ if .message }}{{ .message }}{{ else if .msg }}{{ .msg }}{{ else }}{{ __line__ }}{{ end }}';
  const line = services.length > 1 ? `{{ .${opts.serviceLabel} }}  ${message}` : message;
  const format = ` | json | line_format \`${line}\` | drop __error__, __error_details__`;
  return [`${selector} |= "${needle}"${format}`, `${selector} != "${needle}" | ${metadata}${format}`];
}

/** A trace's duration as the trace view shows it: µs under a millisecond, s from a second. */
export function formatTraceDuration(ms: number): string {
  if (ms < 1) {
    return `${Math.round(ms * 1000)}µs`;
  }
  if (ms < 1000) {
    return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

/** How far around the trace its log lines are searched for: apps log a little before and after. */
export const TRACE_LOGS_MARGIN_MS = 60_000;
