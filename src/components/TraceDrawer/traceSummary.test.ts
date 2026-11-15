import { FieldType, LoadingState, PanelData, toDataFrame } from '@grafana/data';
import { buildTraceLogsQueries, summarizeTrace, traceLookup } from './traceSummary';

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
        { parent: 'a', name: 'SELECT cart_items', service: 'cartservice', start: 1010, duration: 5, status: 2 },
        { parent: '', name: 'GET /api/cart', service: 'cartservice', start: 1000, duration: 40 },
        { parent: 'b', name: 'POST /api/quote', service: 'pricingservice', start: 1030, duration: 25 },
        { parent: 'c', name: 'GET /cart', service: 'frontend', start: 1002, duration: 3, status: 2 },
      ])
    );
    expect(summary).toEqual({
      rootName: 'GET /api/cart',
      rootService: 'cartservice',
      services: ['cartservice', 'frontend', 'pricingservice'],
      startMs: 1000,
      // The pricing span ends after the root.
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

describe('traceLookup', () => {
  const data = (state: LoadingState, extra: Partial<PanelData> = {}) => ({ state, series: [], ...extra }) as PanelData;

  it('is loading until Tempo answers', () => {
    expect(traceLookup(undefined)).toEqual({ status: 'loading' });
    expect(traceLookup(data(LoadingState.Loading))).toEqual({ status: 'loading' });
  });

  it('finds a trace with spans', () => {
    const frame = traceFrame([{ parent: '', name: 'GET /', service: 'a', start: 1, duration: 1 }]);
    expect(traceLookup(data(LoadingState.Done, { series: [frame] }))).toEqual({ status: 'found' });
  });

  it("reports a trace Tempo does not have: an empty answer, or Tempo's 404", () => {
    expect(traceLookup(data(LoadingState.Done))).toEqual({ status: 'not-found' });
    expect(
      traceLookup(data(LoadingState.Error, { errors: [{ message: 'failed to get trace: 404 Not Found' }] }))
    ).toEqual({ status: 'not-found' });
  });

  it('reports a failed lookup as an error, not as a missing trace', () => {
    expect(traceLookup(data(LoadingState.Error, { errors: [{ message: 'Forbidden' }] }))).toEqual({
      status: 'error',
      message: 'Forbidden',
    });
    expect(traceLookup(data(LoadingState.Error, { errors: [{ message: 'connection refused' }] }))).toEqual({
      status: 'error',
      message: 'connection refused',
    });
    // An error without a message is still an error.
    expect(traceLookup(data(LoadingState.Error, { errors: [] }))).toEqual({ status: 'error', message: '' });
  });
});

describe('buildTraceLogsQueries', () => {
  const TRACE = '2f3e0cee77ae5dc9c17ade3689eb2e5';
  const FULL = '02f3e0cee77ae5dc9c17ade3689eb2e5';
  const FORMAT =
    ' | json | line_format `{{ if .message }}{{ .message }}{{ else if .msg }}{{ .msg }}{{ else }}{{ __line__ }}{{ end }}`' +
    ' | drop __error__, __error_details__';

  it('finds the ID in the line, or only in structured metadata, never the same line twice', () => {
    expect(buildTraceLogsQueries(TRACE, { serviceLabel: 'service_name', services: ['cartservice'] })).toEqual([
      // As apps log it, with the leading zero Tempo's search results drop.
      `{service_name="cartservice"} |= "${FULL}"${FORMAT}`,
      // As OTLP logs carry it: in Loki's trace_id metadata, not the line.
      `{service_name="cartservice"} != "${FULL}" | trace_id="${FULL}"${FORMAT}`,
    ]);
  });

  it('searches every service in the trace and names the service on each line', () => {
    const [byLine, byMetadata] = buildTraceLogsQueries(TRACE, {
      serviceLabel: 'service_name',
      services: ['cartservice', 'pricing.v2'],
      clusterLabel: 'k8s_cluster_name',
      clusterFilter: 'prod',
    });
    const selector = '{service_name=~"cartservice|pricing\\\\.v2", k8s_cluster_name="prod"}';
    expect(byLine).toContain(selector);
    expect(byMetadata).toContain(selector);
    expect(byLine).toContain('`{{ .service_name }}  {{ if .message }}');
  });

  it('drops a service name that is not a label value, and gives up when none is left', () => {
    const [byLine] = buildTraceLogsQueries(TRACE, { serviceLabel: 'service_name', services: ['a"} |= "x', 'api'] });
    expect(byLine).toMatch(/^\{service_name="api"\}/);
    expect(buildTraceLogsQueries(TRACE, { serviceLabel: 'service_name', services: [''] })).toEqual([]);
  });
});
