import { DataFrame, DataTopic } from '@grafana/data';
import { CustomTransformOperator, SceneDataProvider, SceneDataTransformer } from '@grafana/scenes';
import { map } from 'rxjs';
import { TRACE_ID_FIELDS, fullTraceId, traceIdDataLink, validTraceId, withDrawerTraceLinks } from './traceLinks';

function withoutCurrentTraceLinks(frame: DataFrame, currentTraceId: string): DataFrame[] {
  const traceFields = frame.fields
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => TRACE_ID_FIELDS.includes(field.name) && field.config.links?.length);
  const excluded = Array.from({ length: frame.length }, (_, row) =>
    traceFields
      .filter(({ field }) => {
        const value = field.values[row];
        const id = typeof value === 'string' ? validTraceId(value) : '';
        return id && fullTraceId(id) === fullTraceId(currentTraceId);
      })
      .map(({ index }) => index)
      .join(',')
  );
  if (!excluded.some(Boolean)) {
    return [frame];
  }

  const frames: DataFrame[] = [];
  let start = 0;
  for (let end = 1; end <= frame.length; end++) {
    if (end === frame.length || excluded[end] !== excluded[start]) {
      const hidden = new Set(excluded[start].split(',').filter(Boolean).map(Number));
      frames.push({
        ...frame,
        length: end - start,
        fields: frame.fields.map((field, index) => ({
          ...field,
          values: field.values.slice(start, end),
          config: hidden.has(index) ? { ...field.config, links: [] } : field.config,
        })),
      });
      start = end;
    }
  }
  return frames;
}

const drawerTraceLinks =
  (currentTraceId?: string): CustomTransformOperator =>
  () =>
  (source) =>
    source.pipe(
      map((frames) =>
        frames.flatMap((frame) => {
          const linked = withDrawerTraceLinks(frame);
          return currentTraceId ? withoutCurrentTraceLinks(linked, currentTraceId) : [linked];
        })
      )
    );

const drawerExemplarLinks: CustomTransformOperator = () => (source) =>
  source.pipe(
    map((frames) =>
      frames.map((frame) => ({
        ...frame,
        fields: frame.fields.map((field) =>
          TRACE_ID_FIELDS.includes(field.name)
            ? { ...field, config: { ...field.config, links: [traceIdDataLink()] } }
            : field
        ),
      }))
    )
  );

/**
 * The data of a panel whose trace links open the trace drawer: Tempo search results, a log
 * line's trace field, and exemplars (which travel as annotations).
 */
export function traceDrawerData($data: SceneDataProvider, currentTraceId?: string): SceneDataTransformer {
  return new SceneDataTransformer({
    $data,
    transformations: [
      drawerTraceLinks(currentTraceId),
      { operator: drawerExemplarLinks, topic: DataTopic.Annotations },
    ],
  });
}
