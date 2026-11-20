import type { MouseEvent } from 'react';
import { DataLink, FieldType, toDataFrame } from '@grafana/data';
import { locationService } from '@grafana/runtime';
import {
  fullTraceId,
  openTraceDrawer,
  openTraceOnClick,
  spanIdDataLink,
  traceDrawerHref,
  traceIdDataLink,
  validSpanId,
  validTraceId,
  withDrawerTraceLinks,
} from './traceLinks';

jest.mock('@grafana/runtime', () => ({
  locationService: {
    partial: jest.fn(),
    getLocation: jest.fn(),
    getHistory: jest.fn(),
  },
}));

const partial = locationService.partial as jest.Mock;
const getLocation = locationService.getLocation as jest.Mock;
const getHistory = locationService.getHistory as jest.Mock;
let createHref: jest.Mock;
let basename = '';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

beforeEach(() => {
  basename = '';
  createHref = jest.fn(
    ({ pathname, search, hash }: { pathname: string; search?: string; hash?: string }) =>
      `${basename}${pathname}${search ?? ''}${hash ?? ''}`
  );
  partial.mockReset();
  getHistory.mockReturnValue({ createHref });
  getLocation.mockReturnValue({
    pathname: '/a/nais-apm-app/services/team/api',
    search: '?tab=traces&traceSpan=middleware+-+%3Canonymous%3E&traceId=old&spanId=old',
    hash: '',
  });
});

describe('validTraceId / validSpanId', () => {
  it('accepts hex IDs and lowercases them', () => {
    expect(validTraceId(TRACE.toUpperCase())).toBe(TRACE);
    expect(validTraceId('2f3e0cee77ae5dc9')).toBe('2f3e0cee77ae5dc9');
    expect(validSpanId('00f067aa0ba902b7')).toBe('00f067aa0ba902b7');
  });

  it('rejects anything that could reach TraceQL or LogQL as something else', () => {
    expect(validTraceId('abc"} | foo')).toBe('');
    expect(validTraceId(`${TRACE}0`)).toBe('');
    expect(validTraceId(null)).toBe('');
    expect(validSpanId(TRACE)).toBe('');
  });
});

it('pads a trace ID Tempo printed without its leading zeros', () => {
  expect(fullTraceId('2f3e0cee77ae5dc9c17ade3689eb2e5')).toBe('02f3e0cee77ae5dc9c17ade3689eb2e5');
  expect(fullTraceId(TRACE)).toBe(TRACE);
});

describe('openTraceDrawer', () => {
  it('sets the trace and clears a span from another trace', () => {
    openTraceDrawer(TRACE);
    expect(partial).toHaveBeenCalledWith({ traceId: TRACE, spanId: null });
  });

  it('focuses a span', () => {
    openTraceDrawer(TRACE, '00f067aa0ba902b7');
    expect(partial).toHaveBeenCalledWith({ traceId: TRACE, spanId: '00f067aa0ba902b7' });
  });

  it('ignores an ID that is not one', () => {
    openTraceDrawer('${__value.raw}');
    expect(partial).not.toHaveBeenCalled();
  });
});

describe('traceDrawerHref', () => {
  it('keeps the page and its params, replacing an open trace', () => {
    expect(traceDrawerHref(TRACE)).toBe(
      `/a/nais-apm-app/services/team/api?tab=traces&traceSpan=middleware+-+%3Canonymous%3E&traceId=${TRACE}`
    );
  });

  it("builds data-link hrefs from the page's URL when Grafana renders the link, not a snapshot", () => {
    // A tab kept mounted in the background would otherwise carry the URL from when its data
    // arrived; Scenes' __url macro reads the location when the link is drawn.
    const page = '${__url.path:raw}${__url.params:exclude:traceId,spanId}';
    expect(traceIdDataLink().url).toBe(`${page}&traceId=\${__value.raw}`);
    expect(spanIdDataLink().url).toBe(`${page}&traceId=\${__data.fields.traceIdHidden}&spanId=\${__value.raw}`);
  });

  it('encodes a $ in other params, so Grafana never reads it as a template', () => {
    getLocation.mockReturnValue({ pathname: '/p', search: '?logSearch=%24__all' });
    expect(traceDrawerHref(TRACE)).toBe(`/p?logSearch=%24__all&traceId=${TRACE}`);
  });

  it('preserves Grafana’s subpath, query params, and hash', () => {
    basename = '/grafana';
    getLocation.mockReturnValue({
      pathname: '/a/nais-apm-app/services/team/api',
      search: '?tab=traces&traceId=old&spanId=old',
      hash: '#logs',
    });

    expect(traceDrawerHref(TRACE)).toBe(`/grafana/a/nais-apm-app/services/team/api?tab=traces&traceId=${TRACE}#logs`);
  });
});

describe('data links', () => {
  it('a trace ID cell opens its trace', () => {
    const replaceVariables = jest.fn((v: string) => (v === '${__value.raw}' ? TRACE : ''));
    traceIdDataLink().onClick!({ origin: {}, replaceVariables });
    expect(partial).toHaveBeenCalledWith({ traceId: TRACE, spanId: null });
  });

  it("a span ID cell opens the span's trace, focused on it", () => {
    const values: Record<string, string> = {
      '${__data.fields.traceIdHidden}': TRACE,
      '${__value.raw}': '00f067aa0ba902b7',
    };
    spanIdDataLink().onClick!({ origin: {}, replaceVariables: (v: string) => values[v] ?? '' });
    expect(partial).toHaveBeenCalledWith({ traceId: TRACE, spanId: '00f067aa0ba902b7' });
  });
});

describe.each([
  { name: 'trace', createLink: traceIdDataLink, spanId: null },
  { name: 'span', createLink: spanIdDataLink, spanId: '00f067aa0ba902b7' },
])('$name data-link clicks', ({ createLink, spanId }) => {
  const replaceVariables = (value: string) => {
    if (value === '${__data.fields.traceIdHidden}') {
      return TRACE;
    }
    return value === '${__value.raw}' ? (spanId ?? TRACE) : '';
  };

  it('prevents browser navigation and opens the drawer once on a normal click', () => {
    const event = new window.MouseEvent('click', { button: 0, cancelable: true });

    createLink().onClick!({ origin: {}, replaceVariables, e: event });

    expect(event.defaultPrevented).toBe(true);
    expect(partial).toHaveBeenCalledTimes(1);
    expect(partial).toHaveBeenCalledWith({ traceId: TRACE, spanId });
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])(
    'leaves browser navigation intact without opening the drawer for %o',
    (init) => {
      const event = new window.MouseEvent('click', { button: 0, cancelable: true, ...init });

      createLink().onClick!({ origin: {}, replaceVariables, e: event });

      expect(event.defaultPrevented).toBe(false);
      expect(partial).not.toHaveBeenCalled();
    }
  );
});

describe('withDrawerTraceLinks', () => {
  // The link a datasource puts on a trace ID: Tempo's search results, Mimir's exemplars, Loki's
  // derived fields all point at Explore.
  const exploreLink: DataLink = {
    title: 'Trace: ${__value.raw}',
    url: '',
    internal: { datasourceUid: 'tempo', datasourceName: 'Tempo', query: { query: '${__value.raw}' } },
  };
  const titles = (links?: DataLink[]) => (links ?? []).map((l) => l.title);

  it("replaces Tempo's link on search results and on their nested spans", () => {
    const spans = toDataFrame({
      name: 'Spans',
      fields: [
        { name: 'traceIdHidden', type: FieldType.string, values: [TRACE] },
        { name: 'spanID', type: FieldType.string, values: ['00f067aa0ba902b7'], config: { links: [exploreLink] } },
      ],
    });
    const traces = toDataFrame({
      name: 'Traces',
      fields: [
        { name: 'traceID', type: FieldType.string, values: [TRACE], config: { links: [exploreLink] } },
        { name: 'traceName', type: FieldType.string, values: ['GET /'] },
        { name: 'nested', type: FieldType.nestedFrames, values: [[spans]] },
      ],
    });

    const out = withDrawerTraceLinks(traces);
    expect(titles(out.fields[0].config.links)).toEqual(['Open trace']);
    expect(out.fields[1]).toBe(traces.fields[1]);
    const nested = out.fields[2].values[0][0];
    expect(titles(nested.fields[1].config.links)).toEqual(['Open span']);
    // The input is left as it was: other panels may share it.
    expect(titles(traces.fields[0].config.links)).toEqual(['Trace: ${__value.raw}']);
  });

  it('handles nested spans still in JSON form', () => {
    const traces = toDataFrame({
      fields: [
        {
          name: 'nested',
          type: FieldType.other,
          values: [
            [
              {
                schema: {
                  fields: [
                    { name: 'traceIdHidden', type: 'string' },
                    { name: 'spanID', type: 'string', config: { links: [exploreLink] } },
                  ],
                },
                data: { values: [[TRACE], ['00f067aa0ba902b7']] },
              },
            ],
          ],
        },
      ],
    });
    const json = withDrawerTraceLinks(traces).fields[0].values[0][0];
    expect(titles(json.schema.fields[1].config.links)).toEqual(['Open span']);
    expect(json.data.values[1]).toEqual(['00f067aa0ba902b7']);
  });

  it("replaces an exemplar's trace link, whatever the label is called", () => {
    for (const name of ['traceID', 'trace_id', 'TraceID', 'Trace']) {
      const frame = toDataFrame({
        fields: [{ name, type: FieldType.string, values: [TRACE], config: { links: [exploreLink] } }],
      });
      expect(titles(withDrawerTraceLinks(frame).fields[0].config.links)).toEqual(['Open trace']);
    }
  });

  it('leaves fields without a trace link alone, and the frame too when nothing changed', () => {
    const frame = toDataFrame({
      fields: [
        { name: 'trace_id', type: FieldType.string, values: [TRACE] },
        { name: 'spanID', type: FieldType.string, values: ['00f067aa0ba902b7'], config: { links: [exploreLink] } },
      ],
    });
    // No link on trace_id, and spanID outside Tempo's span frames is not a span link here.
    expect(withDrawerTraceLinks(frame)).toBe(frame);
  });

  describe('log lines', () => {
    // A Loki log frame: each line's labels hold its parsed fields and structured metadata.
    const logFrame = (labels: Array<Record<string, string>>, extra: Array<Record<string, unknown>> = []) =>
      toDataFrame({
        fields: [
          { name: 'labels', type: FieldType.other, values: labels },
          { name: 'Line', type: FieldType.string, values: labels.map(() => 'cart priced') },
          ...extra,
        ],
      });

    it('link to their trace from their labels, though the shown line no longer has the ID', () => {
      const out = withDrawerTraceLinks(
        logFrame([{ trace_id: TRACE }, { level: 'info' }, { traceID: TRACE.toUpperCase() }])
      );
      const trace = out.fields.find((f) => f.name === 'Trace');
      expect(trace?.values).toEqual([TRACE, null, TRACE]);
      expect(titles(trace?.config.links)).toEqual(['Open trace']);
    });

    it('fill the gaps of a derived field that found nothing in the rewritten line', () => {
      const out = withDrawerTraceLinks(
        logFrame(
          [{ trace_id_extracted: TRACE }, {}],
          [{ name: 'TraceID', type: FieldType.string, values: [null, null], config: { links: [exploreLink] } }]
        )
      );
      expect(out.fields.filter((f) => f.name === 'Trace')).toHaveLength(0);
      const derived = out.fields.find((f) => f.name === 'TraceID');
      expect(derived?.values).toEqual([TRACE, null]);
      expect(titles(derived?.config.links)).toEqual(['Open trace']);
    });

    it('are left alone without a trace ID, or with one that is not', () => {
      const frame = logFrame([{ level: 'info' }, { trace_id: 'not-a-trace' }]);
      expect(withDrawerTraceLinks(frame)).toBe(frame);
    });
  });
});

describe('openTraceOnClick', () => {
  const click = (init: Partial<MouseEvent<HTMLElement>>) =>
    ({
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: jest.fn(),
      ...init,
    }) as unknown as MouseEvent<HTMLElement>;

  it('opens the drawer in place on a click', () => {
    const event = click({});
    openTraceOnClick(TRACE)(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(partial).toHaveBeenCalledWith({ traceId: TRACE, spanId: null });
  });

  it('opens the drawer when called without an event', () => {
    openTraceOnClick(TRACE)();
    expect(partial).toHaveBeenCalledWith({ traceId: TRACE, spanId: null });
  });

  it('leaves a new-tab click to the browser', () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { button: 1 }]) {
      const event = click(init);
      openTraceOnClick(TRACE)(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(partial).not.toHaveBeenCalled();
  });
});
