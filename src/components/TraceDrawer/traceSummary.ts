import { DataFrame, Field, LoadingState, PanelData } from '@grafana/data';
import { escapePromQLRegex } from '../../utils/debounce';
import { escapeQueryString, sanitizeLabelValue } from '../../utils/sanitize';
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

/**
 * Tells a trace Tempo does not have (a successful empty answer, or its 404) from a lookup that
 * failed (no access, network, a Tempo error): the first is about the trace, the second is not.
 */
export function traceLookup(data: PanelData | undefined): TraceLookup {
  if (data?.state === LoadingState.Error) {
    const message = data.errors?.[0]?.message ?? '';
    return /not found|404/i.test(message) ? { status: 'not-found' } : { status: 'error', message };
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
  /** For a Loki shared by environments: the label and value scoping the streams. */
  clusterLabel?: string;
  clusterFilter?: string;
}

/**
 * LogQL for the log lines of one trace, in the streams of the services in the trace. Two
 * queries, so a line is found however it carries the ID and never twice:
 * - the ID in the line itself (a JSON `trace_id`, or anywhere in plain text);
 * - the ID only in Loki's `trace_id` structured metadata, as OTLP logs carry it.
 * Lines from more than one service start with the service's name. Empty when no service name
 * is a valid label value.
 */
export function buildTraceLogsQueries(traceId: string, opts: TraceLogsOptions): string[] {
  const services = opts.services.map(sanitizeLabelValue).filter(Boolean);
  if (services.length === 0) {
    return [];
  }
  const serviceMatcher =
    services.length === 1
      ? `${opts.serviceLabel}="${services[0]}"`
      : `${opts.serviceLabel}=~"${services.map(escapePromQLRegex).join('|')}"`;
  const cluster = opts.clusterFilter ? sanitizeLabelValue(opts.clusterFilter) : '';
  const clusterMatcher = cluster && opts.clusterLabel ? `, ${opts.clusterLabel}="${cluster}"` : '';
  const selector = `{${serviceMatcher}${clusterMatcher}}`;
  const id = escapeQueryString(fullTraceId(traceId));
  const message = '{{ if .message }}{{ .message }}{{ else if .msg }}{{ .msg }}{{ else }}{{ __line__ }}{{ end }}';
  const line = services.length > 1 ? `{{ .${opts.serviceLabel} }}  ${message}` : message;
  const format = ` | json | line_format \`${line}\` | drop __error__, __error_details__`;
  return [`${selector} |= "${id}"${format}`, `${selector} != "${id}" | trace_id="${id}"${format}`];
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
