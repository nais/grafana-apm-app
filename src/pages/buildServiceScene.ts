import {
  SceneFlexLayout,
  SceneFlexItem,
  SceneQueryRunner,
  SceneTimePicker,
  SceneTimeRange,
  SceneRefreshPicker,
  PanelBuilders,
  EmbeddedScene,
  behaviors,
} from '@grafana/scenes';
import { DashboardCursorSync, TooltipDisplayMode } from '@grafana/schema';
import { HeatmapColorMode } from '@grafana/schema/dist/esm/raw/composable/heatmap/panelcfg/x/HeatmapPanelCfg_types.gen';
import { buildTempoExploreUrl, buildLokiExploreUrl, buildMimirExploreUrl } from '../utils/explore';
import { sanitizeLabelValue } from '../utils/sanitize';
import { otel } from '../otelconfig';

export interface BuildServiceSceneParams {
  service: string;
  namespace: string;
  envFilter: string;
  percentile: string;
  percentileLabel: string;
  from: string;
  to: string;
  metricsUid: string;
  tracesUid: string;
  logsUid: string;
  callsMetric: string;
  durationBucket: string;
  durationUnit: string;
  hasServerSpans: boolean;
}

/**
 * Builds the EmbeddedScene for the service overview RED panels (Duration, Errors, Rate, Heatmap).
 * This is a plain builder function (not a hook) to avoid re-creating the scene identity on re-render.
 */
export function buildServiceScene(params: BuildServiceSceneParams): EmbeddedScene | null {
  const {
    service,
    namespace,
    envFilter,
    percentile,
    percentileLabel,
    from,
    to,
    metricsUid,
    tracesUid,
    logsUid,
    callsMetric,
    durationBucket,
    durationUnit,
    hasServerSpans,
  } = params;

  if (!metricsUid) {
    return null;
  }

  const timeRange = new SceneTimeRange({ from, to });
  let svcFilter = `${otel.labels.serviceName}="${sanitizeLabelValue(service)}", ${otel.labels.serviceNamespace}="${sanitizeLabelValue(namespace)}"`;
  if (envFilter) {
    svcFilter += `, ${otel.labels.deploymentEnv}="${sanitizeLabelValue(envFilter)}"`;
  }
  const spanKindFilter = hasServerSpans ? `, ${otel.labels.spanKind}="${otel.spanKinds.server}"` : '';
  const panelDurationUnit = durationUnit === 's' ? 's' : 'ms';

  const panelScope = hasServerSpans ? 'inbound (SERVER)' : 'all';
  const durationDesc = `${percentileLabel} response time for ${panelScope} requests`;
  const errorDesc = `Percentage of ${panelScope} requests resulting in an error status`;
  const rateDesc = `Throughput of ${panelScope} requests per second`;
  const heatmapDesc = `Distribution of ${panelScope} request durations over time`;

  const durationQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        expr: `histogram_quantile(${percentile}, sum by (${otel.labels.le}) (rate(${durationBucket}{${svcFilter}${spanKindFilter}}[$__rate_interval])))`,
        legendFormat: percentileLabel,
        exemplar: true,
      },
    ],
  });

  const errorQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        expr: `sum(rate(${callsMetric}{${svcFilter}${spanKindFilter}, ${otel.labels.statusCode}="${otel.statusCodes.error}"}[$__rate_interval])) / sum(rate(${callsMetric}{${svcFilter}${spanKindFilter}}[$__rate_interval])) * 100`,
        legendFormat: 'Error %',
        exemplar: true,
      },
    ],
  });

  const rateQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        expr: `sum(rate(${callsMetric}{${svcFilter}${spanKindFilter}}[$__rate_interval]))`,
        legendFormat: 'Rate',
        exemplar: true,
      },
    ],
  });

  const tempoUrl = buildTempoExploreUrl(tracesUid, service, { namespace });
  const lokiUrl = buildLokiExploreUrl(logsUid, service, { namespace });
  const mimirUrl = buildMimirExploreUrl(
    metricsUid,
    `sum(rate(${callsMetric}{${otel.labels.serviceName}="${service}", ${otel.labels.serviceNamespace}="${namespace}"${spanKindFilter}}[5m]))`
  );

  const heatmapQuery = new SceneQueryRunner({
    datasource: { uid: metricsUid, type: 'prometheus' },
    minInterval: '5m',
    queries: [
      {
        refId: 'A',
        expr: `sum by (${otel.labels.le}) (increase(${durationBucket}{${svcFilter}${spanKindFilter}}[$__rate_interval]))`,
        format: 'heatmap',
        legendFormat: '{{le}}',
      },
    ],
  });

  // Override exemplar links to point to the environment-resolved Tempo datasource
  // (the Mimir datasource's built-in exemplar config always points to the default Tempo).
  const exemplarOverride = (b: any) =>
    tracesUid
      ? b.matchFieldsWithName('traceID').overrideLinks([
          {
            title: 'View trace',
            url: '',
            internal: {
              query: { query: '${__value.raw}', queryType: 'traceql' },
              datasourceUid: tracesUid,
              datasourceName: '',
            },
          },
        ])
      : b;

  return new EmbeddedScene({
    $timeRange: timeRange,
    $behaviors: [new behaviors.CursorSync({ sync: DashboardCursorSync.Crosshair })],
    controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
    body: new SceneFlexLayout({
      direction: 'column',
      children: [
        new SceneFlexItem({
          body: new SceneFlexLayout({
            direction: 'row',
            children: [
              new SceneFlexItem({
                height: 300,
                body: PanelBuilders.timeseries()
                  .setTitle('Duration')
                  .setDescription(durationDesc)
                  .setData(durationQuery)
                  .setUnit(panelDurationUnit)
                  .setOverrides(exemplarOverride)
                  .setLinks([
                    { title: 'Traces', url: tempoUrl, targetBlank: false },
                    { title: 'Logs', url: lokiUrl, targetBlank: false },
                  ])
                  .build(),
              }),
              new SceneFlexItem({
                height: 300,
                body: PanelBuilders.timeseries()
                  .setTitle('Errors')
                  .setDescription(errorDesc)
                  .setData(errorQuery)
                  .setUnit('percent')
                  .setOverrides(exemplarOverride)
                  .setLinks([
                    { title: 'Traces', url: tempoUrl, targetBlank: false },
                    { title: 'Logs', url: lokiUrl, targetBlank: false },
                  ])
                  .build(),
              }),
              new SceneFlexItem({
                height: 300,
                body: PanelBuilders.timeseries()
                  .setTitle('Rate')
                  .setDescription(rateDesc)
                  .setData(rateQuery)
                  .setUnit('reqps')
                  .setOverrides(exemplarOverride)
                  .setLinks([{ title: 'Explore', url: mimirUrl, targetBlank: false }])
                  .build(),
              }),
            ],
          }),
        }),
        new SceneFlexItem({
          height: 220,
          body: PanelBuilders.heatmap()
            .setTitle('Duration Distribution')
            .setDescription(heatmapDesc)
            .setData(heatmapQuery)
            .setOption('calculate', false)
            .setOption('yAxis', {
              unit: durationUnit === 's' ? 's' : 'ms',
            })
            .setOption('color', {
              mode: HeatmapColorMode.Scheme,
              scheme: 'Oranges',
              steps: 128,
            })
            .setOption('cellGap', 1)
            .setOption('tooltip', { mode: TooltipDisplayMode.Single, yHistogram: true })
            .build(),
        }),
      ],
    }),
  });
}
