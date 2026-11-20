import { DataFrame, DataTopic, FieldType, LoadingState, getDefaultTimeRange, toDataFrame } from '@grafana/data';
import { SceneDataNode } from '@grafana/scenes';
import { firstValueFrom } from 'rxjs';
import { traceDrawerData } from './traceDrawerData';
import { traceIdDataLink } from './traceLinks';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

async function transform(series: DataFrame[], annotations: DataFrame[], currentTraceId?: string) {
  const source = new SceneDataNode({
    data: { state: LoadingState.Done, series, annotations, timeRange: getDefaultTimeRange() },
  });
  const transformer = traceDrawerData(source, currentTraceId);
  const deactivate = transformer.activate();
  try {
    return (await firstValueFrom(transformer.getResultsStream())).data;
  } finally {
    deactivate();
  }
}

describe('traceDrawerData', () => {
  it.each(['traceID', 'trace_id', 'TraceID', 'Trace'])(
    'adds a drawer link to an unlinked %s exemplar field',
    async (name) => {
      const exemplar = toDataFrame({
        meta: { dataTopic: DataTopic.Annotations },
        fields: [
          { name: 'Time', type: FieldType.time, values: [1000] },
          { name, type: FieldType.string, values: [TRACE], config: { displayName: 'Trace ID' } },
        ],
      });

      const result = await transform([], [exemplar]);

      expect(result.annotations?.[0].fields[1].config).toEqual({
        displayName: 'Trace ID',
        links: [
          expect.objectContaining({ title: 'Open trace', url: traceIdDataLink().url, onClick: expect.any(Function) }),
        ],
      });
      expect(result.annotations?.[0].fields[0]).toBe(exemplar.fields[0]);
      expect(exemplar.fields[1].config.links).toBeUndefined();
    }
  );

  it('replaces an existing exemplar link without changing other fields', async () => {
    const links = [{ title: 'Open in Explore', url: '/explore' }];
    const exemplar = toDataFrame({
      meta: { dataTopic: DataTopic.Annotations },
      fields: [
        { name: 'traceID', type: FieldType.string, values: [TRACE], config: { links } },
        { name: 'service', type: FieldType.string, values: ['api'], config: { links } },
      ],
    });

    const result = await transform([], [exemplar]);

    expect(result.annotations?.[0].fields[0].config.links).toEqual([
      expect.objectContaining({ title: 'Open trace', url: traceIdDataLink().url, onClick: expect.any(Function) }),
    ]);
    expect(result.annotations?.[0].fields[1]).toBe(exemplar.fields[1]);
    expect(exemplar.fields[0].config.links).toBe(links);
  });

  it('keeps unlinked trace fields in regular series unchanged', async () => {
    const series = toDataFrame({
      fields: [{ name: 'traceID', type: FieldType.string, values: [TRACE] }],
    });
    const linkedSeries = toDataFrame({
      fields: [
        {
          name: 'traceID',
          type: FieldType.string,
          values: [TRACE],
          config: { links: [{ title: 'Open in Explore', url: '/explore' }] },
        },
      ],
    });

    const result = await transform([series, linkedSeries], []);

    expect(result.series[0]).toBe(series);
    expect(result.series[0].fields[0].config.links).toBeUndefined();
    expect(result.series[1].fields[0].config.links).toEqual([
      expect.objectContaining({ title: 'Open trace', url: traceIdDataLink().url, onClick: expect.any(Function) }),
    ]);
    expect(result.annotations).toEqual([]);
  });

  it('removes the current trace link in drawer logs while preserving IDs and other links', async () => {
    const labels = [{ trace_id: TRACE }, { trace_id: TRACE }];
    const otherLinks = [{ title: 'Runbook', url: 'https://example.com/runbook' }];
    const frame = toDataFrame({
      refId: 'A',
      fields: [
        { name: 'Line', type: FieldType.string, values: ['first', 'second'] },
        { name: 'labels', type: FieldType.other, values: labels },
        {
          name: 'TraceID',
          type: FieldType.string,
          values: [TRACE, TRACE.toUpperCase()],
          config: { links: [{ title: 'Explore', url: '/explore' }] },
        },
        { name: 'Runbook', type: FieldType.string, values: ['help', 'help'], config: { links: otherLinks } },
      ],
    });

    const result = await transform([frame], [], TRACE);

    expect(result.series).toHaveLength(1);
    expect(result.series[0].fields[2].config.links).toEqual([]);
    expect(result.series[0].fields[2].values).toEqual([TRACE, TRACE.toUpperCase()]);
    expect(result.series[0].fields[1].values).toEqual(labels);
    expect(result.series[0].fields[3].config.links).toBe(otherLinks);
    expect(frame.fields[2].config.links).toEqual([{ title: 'Explore', url: '/explore' }]);
  });

  it('hides synthesized self-links without adding a linked field for those rows', async () => {
    const frame = toDataFrame({
      fields: [
        { name: 'Line', type: FieldType.string, values: ['first'] },
        { name: 'labels', type: FieldType.other, values: [{ trace_id: TRACE }] },
      ],
    });

    const result = await transform([frame], [], TRACE);

    const trace = result.series[0].fields.find((field) => field.name === 'Trace');
    expect(trace?.values).toEqual([TRACE]);
    expect(trace?.config.links).toEqual([]);
    expect(result.series[0].fields.every((field) => !field.config.links?.length)).toBe(true);
  });

  it('keeps links to other traces in mixed frames without changing row order or metadata', async () => {
    const other = '11111111111111111111111111111111';
    const ids = [TRACE, other, TRACE];
    const labels = ids.map((trace_id) => ({ trace_id }));
    const lines = ['first', 'second', 'third'];
    const frame = toDataFrame({
      name: 'service logs',
      refId: 'B',
      meta: { custom: { source: 'loki' } },
      fields: [
        { name: 'Time', type: FieldType.time, values: [1, 2, 3] },
        { name: 'Line', type: FieldType.string, values: lines },
        { name: 'labels', type: FieldType.other, values: labels },
      ],
    });

    const result = await transform([frame], [], TRACE);

    expect(result.series).toHaveLength(3);
    expect(
      result.series.map((part) => part.fields.find((field) => field.name === 'Trace')?.config.links?.length)
    ).toEqual([0, 1, 0]);
    expect(result.series.flatMap((part) => part.fields.find((field) => field.name === 'Trace')?.values ?? [])).toEqual(
      ids
    );
    expect(result.series.flatMap((part) => part.fields[1].values)).toEqual(lines);
    expect(result.series.flatMap((part) => part.fields[2].values)).toEqual(labels);
    expect(
      result.series.every((part) => part.refId === 'B' && part.name === frame.name && part.meta === frame.meta)
    ).toBe(true);
    expect(result.series.every((part) => part.fields.every((field) => field.values.length === part.length))).toBe(true);
  });

  it('matches padded and short forms of the same trace ID', async () => {
    const short = '2f3e0cee77ae5dc9';
    const frame = toDataFrame({
      fields: [
        { name: 'Line', type: FieldType.string, values: ['first'] },
        { name: 'labels', type: FieldType.other, values: [{ trace_id: short }] },
      ],
    });

    const result = await transform([frame], [], short.padStart(32, '0'));

    const trace = result.series[0].fields.find((field) => field.name === 'Trace');
    expect(trace?.values).toEqual([short]);
    expect(trace?.config.links).toEqual([]);
  });

  it('keeps the normal Logs tab links even when a drawer is open on the same trace', async () => {
    const frame = toDataFrame({
      fields: [
        { name: 'Line', type: FieldType.string, values: ['first'] },
        { name: 'labels', type: FieldType.other, values: [{ trace_id: TRACE }] },
      ],
    });

    const result = await transform([frame], []);

    expect(result.series[0].fields.find((field) => field.name === 'Trace')?.config.links).toEqual([
      expect.objectContaining({ title: 'Open trace', url: traceIdDataLink().url }),
    ]);
  });
});
