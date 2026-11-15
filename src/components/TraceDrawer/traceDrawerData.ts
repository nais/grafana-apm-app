import { DataTopic } from '@grafana/data';
import { CustomTransformOperator, SceneDataProvider, SceneDataTransformer } from '@grafana/scenes';
import { map } from 'rxjs';
import { withDrawerTraceLinks } from './traceLinks';

const drawerTraceLinks: CustomTransformOperator = () => (source) =>
  source.pipe(map((frames) => frames.map(withDrawerTraceLinks)));

/**
 * The data of a panel whose trace links open the trace drawer: Tempo search results, a log
 * line's trace field, and exemplars (which travel as annotations).
 */
export function traceDrawerData($data: SceneDataProvider): SceneDataTransformer {
  return new SceneDataTransformer({
    $data,
    transformations: [drawerTraceLinks, { operator: drawerTraceLinks, topic: DataTopic.Annotations }],
  });
}
