import { FieldType, toDataFrame } from '@grafana/data';
import { buildTraceLogsExpr, summarizeTrace } from './traceSummary';

// One row per span, as Tempo's trace-by-ID query returns it (times in ms).
function traceFrame(
  spans: Array<{ parent: string; name: string; service: string; start: number; duration: number; status?: number }>
) {
  return toDataFrame({
    fields: [
      { name: 'parentSpanID', type: FieldType.string, values: spans.map((s) => s.parent) },
      { name: 'operationName', type: FieldType.string, values: spans.map((s) => s.name) },
      { name: 'serviceName', type: FieldType.string, values: spans.map((s) => s.service) },
      { name: 'startTime', type: FieldType.number, values: spans.map((s) => s.start) },
      { name: 'duration', type: FieldType.number, values: spans.map((s) => s.duration) },
      { name: 'statusCode', type: FieldType.number, values: spans.map((s) => s.status ?? 0) },
    ],
  });
}

describe('summarizeTrace', () => {
  it('names the trace after its root span and counts services, spans and errors', () => {
    const summary = summarizeTrace(
      traceFrame([
        { parent: 'a', name: 'SELECT raffles', service: 'raffles', start: 1010, duration: 5, status: 2 },
        { parent: '', name: 'GET /v1/raffles', service: 'raffles', start: 1000, duration: 40 },
        { parent: 'b', name: 'publish', service: 'socket', start: 1030, duration: 25 },
        { parent: 'c', name: 'auth', service: 'services', start: 1002, duration: 3, status: 2 },
      ])
    );
    expect(summary).toEqual({
      rootName: 'GET /v1/raffles',
      rootService: 'raffles',
      services: ['raffles', 'services', 'socket'],
      startMs: 1000,
      // The socket span ends after the root.
      durationMs: 55,
      spanCount: 4,
      errorCount: 2,
    });
  });

  it('falls back to the earliest span when the root is missing', () => {
    const summary = summarizeTrace(
      traceFrame([
        { parent: 'x', name: 'late', service: 'b', start: 20, duration: 1 },
        { parent: 'y', name: 'early', service: 'a', start: 10, duration: 1 },
      ])
    );
    expect(summary?.rootName).toBe('early');
    expect(summary?.services).toEqual(['a', 'b']);
  });

  it('is undefined until there is a trace', () => {
    expect(summarizeTrace(undefined)).toBeUndefined();
    expect(summarizeTrace(traceFrame([]))).toBeUndefined();
    expect(summarizeTrace(toDataFrame({ fields: [{ name: 'traceID', values: ['abc'] }] }))).toBeUndefined();
  });
});

describe('buildTraceLogsExpr', () => {
  const TRACE = '2f3e0cee77ae5dc9c17ade3689eb2e5';

  it("searches one service's streams for the trace ID as apps log it", () => {
    expect(buildTraceLogsExpr(TRACE, { serviceLabel: 'service', services: ['raffles'] })).toBe(
      '{service="raffles"} |= "02f3e0cee77ae5dc9c17ade3689eb2e5" | json | line_format ' +
        '`{{ if .message }}{{ .message }}{{ else if .msg }}{{ .msg }}{{ else }}{{ __line__ }}{{ end }}`' +
        ' | drop __error__, __error_details__'
    );
  });

  it('searches every service in the trace and names the service on each line', () => {
    const expr = buildTraceLogsExpr(TRACE, {
      serviceLabel: 'service',
      services: ['raffles', 'socket.io'],
      clusterLabel: 'deployment_environment',
      clusterFilter: 'staging',
    });
    expect(expr).toContain('{service=~"raffles|socket\\\\.io", deployment_environment="staging"}');
    expect(expr).toContain('`{{ .service }}  {{ if .message }}');
  });

  it('drops a service name that is not a label value, and gives up when none is left', () => {
    expect(buildTraceLogsExpr(TRACE, { serviceLabel: 'service', services: ['a"} |= "x', 'api'] })).toMatch(
      /^\{service="api"\}/
    );
    expect(buildTraceLogsExpr(TRACE, { serviceLabel: 'service', services: [''] })).toBe('');
  });
});
