import { SceneDataLayerSet, dataLayers } from '@grafana/scenes';
import {
  buildDeployAnnotationsLayer,
  buildServiceScene,
  BuildServiceSceneParams,
  DeployAnnotationTarget,
} from './buildServiceScene';

const defaultParams: BuildServiceSceneParams = {
  service: 'frontend',
  namespace: 'otel-demo',
  envFilter: 'production',
  percentile: '0.95',
  percentileLabel: 'P95',
  from: 'now-1h',
  to: 'now',
  metricsUid: 'prometheus-uid',
  tracesUid: 'tempo-uid',
  logsUid: 'loki-uid',
  callsMetric: 'traces_spanmetrics_calls_total',
  durationBucket: 'traces_spanmetrics_duration_milliseconds_bucket',
  durationUnit: 'ms',
  hasServerSpans: true,
  serviceNameLabel: 'service_name',
  serviceNamespaceLabel: 'service_namespace',
  deploymentEnvLabel: 'k8s_cluster_name',
};

describe('buildServiceScene', () => {
  it('returns null when callsMetric is empty', () => {
    const scene = buildServiceScene({ ...defaultParams, callsMetric: '' });
    expect(scene).toBeNull();
  });

  it('returns null when durationBucket is empty', () => {
    const scene = buildServiceScene({ ...defaultParams, durationBucket: '' });
    expect(scene).toBeNull();
  });

  it('returns null when metricsUid is empty', () => {
    const scene = buildServiceScene({ ...defaultParams, metricsUid: '' });
    expect(scene).toBeNull();
  });

  it('returns a valid EmbeddedScene when all required params are provided', () => {
    const scene = buildServiceScene(defaultParams);
    expect(scene).not.toBeNull();
    expect(scene!.state).toBeDefined();
  });

  it('includes service and namespace in scene queries', () => {
    const scene = buildServiceScene(defaultParams);
    expect(scene).not.toBeNull();

    const body = scene!.state.body;
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('frontend');
    expect(serialized).toContain('otel-demo');
  });

  it('includes environment filter when provided', () => {
    const scene = buildServiceScene(defaultParams);
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('production');
  });

  it('omits environment filter when envFilter is empty', () => {
    const scene = buildServiceScene({ ...defaultParams, envFilter: '' });
    expect(scene).not.toBeNull();
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('frontend');
  });

  it('omits the namespace filter when the namespace is empty', () => {
    const scene = buildServiceScene({ ...defaultParams, namespace: '' });
    expect(scene).not.toBeNull();
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('service_name=\\"frontend\\"');
    expect(serialized).not.toContain('service_namespace=\\"\\"');
  });

  it('uses label overrides when provided', () => {
    const scene = buildServiceScene({
      ...defaultParams,
      serviceNameLabel: 'service',
      serviceNamespaceLabel: 'k8s_namespace_name',
      deploymentEnvLabel: 'deployment_environment',
    });
    expect(scene).not.toBeNull();
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('service=\\"frontend\\"');
    expect(serialized).toContain('k8s_namespace_name=\\"otel-demo\\"');
    expect(serialized).toContain('deployment_environment=\\"production\\"');
    expect(serialized).not.toContain('service_name=\\"frontend\\"');
  });

  it('uses SERVER span kind filter when hasServerSpans is true', () => {
    const scene = buildServiceScene({ ...defaultParams, hasServerSpans: true });
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).toContain('SPAN_KIND_SERVER');
  });

  it('omits span kind filter when hasServerSpans is false', () => {
    const scene = buildServiceScene({ ...defaultParams, hasServerSpans: false });
    const serialized = JSON.stringify(scene!.state.body);
    expect(serialized).not.toContain('SPAN_KIND_SERVER');
  });

  it('attaches a deploy annotations data layer filtered by service and env tags', () => {
    const scene = buildServiceScene(defaultParams);
    const layerSet = scene!.state.$data as SceneDataLayerSet;
    expect(layerSet).toBeInstanceOf(SceneDataLayerSet);

    const layer = layerSet.state.layers[0] as InstanceType<typeof dataLayers.AnnotationsDataLayer>;
    expect(layer).toBeInstanceOf(dataLayers.AnnotationsDataLayer);
    expect(layer.state.query.datasource).toEqual({ type: 'grafana', uid: '-- Grafana --' });
    expect(layer.state.query.target).toEqual({
      type: 'tags',
      matchAny: false,
      tags: ['nais-apm:deploy', 'service:frontend', 'env:production'],
      limit: 100,
    });
  });

  it('omits the env tag from the deploy annotation layer when envFilter is empty', () => {
    const scene = buildServiceScene({ ...defaultParams, envFilter: '' });
    const layerSet = scene!.state.$data as SceneDataLayerSet;
    const layer = layerSet.state.layers[0] as InstanceType<typeof dataLayers.AnnotationsDataLayer>;
    const target = layer.state.query.target as unknown as DeployAnnotationTarget;
    expect(target.tags).toEqual(['nais-apm:deploy', 'service:frontend']);
  });
});

describe('buildDeployAnnotationsLayer', () => {
  it('queries the built-in grafana annotations datasource by tags', () => {
    const layerSet = buildDeployAnnotationsLayer('myapp', 'prod-gcp');
    const layer = layerSet.state.layers[0] as InstanceType<typeof dataLayers.AnnotationsDataLayer>;
    expect(layer.state.query).toMatchObject({
      enable: true,
      datasource: { type: 'grafana', uid: '-- Grafana --' },
      target: {
        type: 'tags',
        matchAny: false,
        tags: ['nais-apm:deploy', 'service:myapp', 'env:prod-gcp'],
        limit: 100,
      },
    });
  });

  it('omits the env tag when no environment is given', () => {
    const layerSet = buildDeployAnnotationsLayer('myapp');
    const layer = layerSet.state.layers[0] as InstanceType<typeof dataLayers.AnnotationsDataLayer>;
    const target = layer.state.query.target as unknown as DeployAnnotationTarget;
    expect(target.tags).toEqual(['nais-apm:deploy', 'service:myapp']);
  });
});
