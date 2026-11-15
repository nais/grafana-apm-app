import { DataFrame, Field } from '@grafana/data';
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

interface TraceLogsOptions {
  /** Loki stream label naming the service. */
  serviceLabel: string;
  /** Services whose streams are searched: the trace's, or the page's service before it loads. */
  services: string[];
  /** For a Loki shared by environments: the label and value scoping the streams. */
  clusterLabel?: string;
  clusterFilter?: string;
}

/**
 * LogQL for the log lines of one trace: the streams of the services in the trace, filtered on
 * the trace ID as apps write it (JSON `trace_id`). Lines from more than one service start with
 * the service's name.
 */
export function buildTraceLogsExpr(traceId: string, opts: TraceLogsOptions): string {
  const services = opts.services.map(sanitizeLabelValue).filter(Boolean);
  if (services.length === 0) {
    return '';
  }
  const serviceMatcher =
    services.length === 1
      ? `${opts.serviceLabel}="${services[0]}"`
      : `${opts.serviceLabel}=~"${services.map(escapePromQLRegex).join('|')}"`;
  const cluster = opts.clusterFilter ? sanitizeLabelValue(opts.clusterFilter) : '';
  const clusterMatcher = cluster && opts.clusterLabel ? `, ${opts.clusterLabel}="${cluster}"` : '';
  const message = '{{ if .message }}{{ .message }}{{ else if .msg }}{{ .msg }}{{ else }}{{ __line__ }}{{ end }}';
  const line = services.length > 1 ? `{{ .${opts.serviceLabel} }}  ${message}` : message;
  return (
    `{${serviceMatcher}${clusterMatcher}} |= "${escapeQueryString(fullTraceId(traceId))}"` +
    ` | json | line_format \`${line}\` | drop __error__, __error_details__`
  );
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
