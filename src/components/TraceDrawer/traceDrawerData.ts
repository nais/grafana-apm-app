import { DataTopic } from '@grafana/data';
import { CustomTransformOperator, SceneDataProvider, SceneDataTransformer } from '@grafana/scenes';
import { map } from 'rxjs';
import { TRACE_ID_FIELDS, traceIdDataLink, withDrawerTraceLinks } from './traceLinks';

const drawerTraceLinks: CustomTransformOperator = () => (source) =>
  source.pipe(map((frames) => frames.map(withDrawerTraceLinks)));

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
export function traceDrawerData($data: SceneDataProvider): SceneDataTransformer {
  return new SceneDataTransformer({
    $data,
    transformations: [drawerTraceLinks, { operator: drawerExemplarLinks, topic: DataTopic.Annotations }],
  });
}
