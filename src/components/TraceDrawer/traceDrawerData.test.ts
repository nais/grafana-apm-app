import { DataFrame, DataTopic, FieldType, LoadingState, getDefaultTimeRange, toDataFrame } from '@grafana/data';
import { SceneDataNode } from '@grafana/scenes';
import { firstValueFrom } from 'rxjs';
import { traceDrawerData } from './traceDrawerData';
import { traceIdDataLink } from './traceLinks';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

async function transform(series: DataFrame[], annotations: DataFrame[]) {
  const source = new SceneDataNode({
    data: { state: LoadingState.Done, series, annotations, timeRange: getDefaultTimeRange() },
  });
  const transformer = traceDrawerData(source);
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
});
