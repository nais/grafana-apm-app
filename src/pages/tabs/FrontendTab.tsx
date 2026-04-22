import React, { useEffect, useMemo, useState } from 'react';
import { useStyles2, Alert, LinkButton, Icon, LoadingPlaceholder } from '@grafana/ui';
import { GrafanaTheme2, ThresholdsMode } from '@grafana/data';
import { css } from '@emotion/css';
import {
  SceneFlexLayout,
  SceneFlexItem,
  SceneQueryRunner,
  SceneTimeRange,
  SceneTimePicker,
  SceneRefreshPicker,
  SceneDataTransformer,
  PanelBuilders,
  EmbeddedScene,
  behaviors,
} from '@grafana/scenes';
import { DashboardCursorSync, GraphThresholdsStyleMode } from '@grafana/schema';
import { getFrontendMetrics } from '../../api/client';
import { usePluginDatasources } from '../../utils/datasources';
import { useTimeRange } from '../../utils/timeRange';
import { sanitizeLabelValue } from '../../utils/sanitize';
import { otel } from '../../otelconfig';
import { buildLokiExploreUrl } from '../../utils/explore';

interface FrontendTabProps {
  service: string;
  namespace: string;
  environment?: string;
}

type FrontendSource = 'mimir' | 'loki';

export function FrontendTab({ service, namespace, environment }: FrontendTabProps) {
  const styles = useStyles2(getStyles);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [source, setSource] = useState<FrontendSource | null>(null);

  useEffect(() => {
    getFrontendMetrics(namespace, service, environment || undefined)
      .then((r) => {
        setAvailable(r.available);
        setSource((r.source as FrontendSource) ?? null);
      })
      .catch(() => setAvailable(false));
  }, [service, namespace, environment]);

  if (available === null) {
    return <LoadingPlaceholder text="Checking for browser telemetry..." />;
  }

  if (!available || !source) {
    return <SetupPlaceholder namespace={namespace} service={service} />;
  }

  return (
    <div className={styles.container}>
      {source === 'loki' && <LokiWebVitalsPanels service={service} environment={environment} />}
      {source === 'mimir' && <MimirWebVitalsPanels service={service} namespace={namespace} />}
    </div>
  );
}

// ---- helpers ----

function statPanel(
  title: string,
  description: string,
  query: SceneQueryRunner,
  unit: string,
  thresholds: Array<{ value: number; color: string }>,
  decimals?: number
) {
  const builder = PanelBuilders.stat().setTitle(title).setDescription(description).setData(query).setUnit(unit);
  if (decimals !== undefined) {
    builder.setDecimals(decimals);
  }
  return builder
    .setOverrides((b) =>
      b.matchFieldsWithName(title).overrideThresholds({
        mode: ThresholdsMode.Absolute,
        steps: thresholds.map((t) => ({ value: t.value, color: t.color })),
      })
    )
    .build();
}

function makePromQuery(
  ds: { uid: string },
  expr: string,
  legendFormat: string,
  opts?: { minInterval?: string; format?: string; instant?: boolean }
) {
  return new SceneQueryRunner({
    datasource: { uid: ds.uid, type: 'prometheus' },
    ...(opts?.minInterval ? { minInterval: opts.minInterval } : {}),
    queries: [
      {
        refId: 'A',
        expr,
        legendFormat,
        ...(opts?.format ? { format: opts.format } : {}),
        ...(opts?.instant ? { instant: true } : {}),
      },
    ],
  });
}

function makeLokiQuery(ds: { uid: string }, expr: string, legendFormat: string, opts?: { instant?: boolean }) {
  return new SceneQueryRunner({
    datasource: { uid: ds.uid, type: 'loki' },
    queries: [
      {
        refId: 'A',
        expr,
        legendFormat,
        ...(opts?.instant ? { instant: true } : {}),
      },
    ],
  });
}

// ---- Vital thresholds (shared between Mimir and Loki panels) ----

const VITAL_THRESHOLDS = {
  lcp: [
    { value: 0, color: 'green' },
    { value: 2500, color: 'orange' },
    { value: 4000, color: 'red' },
  ],
  fcp: [
    { value: 0, color: 'green' },
    { value: 1800, color: 'orange' },
    { value: 3000, color: 'red' },
  ],
  cls: [
    { value: 0, color: 'green' },
    { value: 0.1, color: 'orange' },
    { value: 0.25, color: 'red' },
  ],
  inp: [
    { value: 0, color: 'green' },
    { value: 200, color: 'orange' },
    { value: 500, color: 'red' },
  ],
  ttfb: [
    { value: 0, color: 'green' },
    { value: 800, color: 'orange' },
    { value: 1800, color: 'red' },
  ],
};

// ---- LogQL helper for Faro vital queries ----

function lokiVitalPipeline(service: string, vital: string, extraKeep?: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"}`;
  const keepFields = extraKeep ? `${vital}, ${extraKeep}` : vital;
  return `${stream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" | ${vital}!="" | keep ${keepFields} | unwrap ${vital}`;
}

// Weighted mean: sum(values) / count(values) across all streams.
function lokiVitalExpr(service: string, vital: string, window: string): string {
  const pipeline = lokiVitalPipeline(service, vital);
  return `sum(sum_over_time(${pipeline} ${window})) / sum(count_over_time(${pipeline} ${window}))`;
}

function lokiVitalByGroupExpr(service: string, vital: string, groupBy: string, window: string): string {
  const pipeline = lokiVitalPipeline(service, vital, groupBy);
  return `sum by (${groupBy}) (sum_over_time(${pipeline} ${window})) / sum by (${groupBy}) (count_over_time(${pipeline} ${window}))`;
}

function lokiExceptionExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"}`;
  return `sum(count_over_time(${stream} ${window}))`;
}

function lokiTopExceptionsExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"}`;
  return `topk(20, sum by (value) (count_over_time(${stream} | logfmt | value!="" | keep value ${window})))`;
}

function lokiExceptionSessionsExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"}`;
  return `topk(20, count by (value) (sum by (value, session_id) (count_over_time(${stream} | logfmt | value!="" | session_id!="" | keep value, session_id ${window}))))`;
}

function lokiSessionStartExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindEvent}"}`;
  return `sum(count_over_time(${stream} | logfmt | event_name="session_start" ${window}))`;
}

function lokiConsoleErrorsExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindLog}"}`;
  return `topk(10, sum by (value) (count_over_time(${stream} | logfmt | level="error" | value!="" | keep value ${window})))`;
}

function lokiMeasurementCountExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"}`;
  return `sum(count_over_time(${stream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" ${window}))`;
}

// ========================================================================
// Loki-based Web Vitals panels (Faro data in Loki)
// ========================================================================

function LokiWebVitalsPanels({ service, environment }: { service: string; environment?: string }) {
  const ds = usePluginDatasources(environment || undefined);
  const { from, to } = useTimeRange();

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from, to });
    const lDs = { uid: ds.logsUid };

    // --- Row 1: Core Web Vitals stat panels (use $__range for full-range stats) ---
    const lcpQ = makeLokiQuery(lDs, lokiVitalExpr(service, otel.faroLoki.lcp, '[$__range]'), 'LCP', { instant: true });
    const fcpQ = makeLokiQuery(lDs, lokiVitalExpr(service, otel.faroLoki.fcp, '[$__range]'), 'FCP', { instant: true });
    const clsQ = makeLokiQuery(lDs, lokiVitalExpr(service, otel.faroLoki.cls, '[$__range]'), 'CLS', { instant: true });
    const inpQ = makeLokiQuery(lDs, lokiVitalExpr(service, otel.faroLoki.inp, '[$__range]'), 'INP', { instant: true });
    const ttfbQ = makeLokiQuery(lDs, lokiVitalExpr(service, otel.faroLoki.ttfb, '[$__range]'), 'TTFB', {
      instant: true,
    });

    const vitalsRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('LCP', 'Largest Contentful Paint — target < 2500ms', lcpQ, 'ms', VITAL_THRESHOLDS.lcp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('FCP', 'First Contentful Paint — target < 1800ms', fcpQ, 'ms', VITAL_THRESHOLDS.fcp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('CLS', 'Cumulative Layout Shift — target < 0.1', clsQ, 'none', VITAL_THRESHOLDS.cls, 3),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('INP', 'Interaction to Next Paint — target < 200ms', inpQ, 'ms', VITAL_THRESHOLDS.inp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('TTFB', 'Time to First Byte — target < 800ms', ttfbQ, 'ms', VITAL_THRESHOLDS.ttfb),
        }),
      ],
    });

    // --- Row 2: Web Vitals time series trends (use $__auto for trend resolution) ---
    const pageLoadVitalsQ = new SceneQueryRunner({
      datasource: { uid: ds.logsUid, type: 'loki' },
      queries: [
        { refId: 'A', expr: lokiVitalExpr(service, otel.faroLoki.ttfb, '[$__auto]'), legendFormat: 'TTFB' },
        { refId: 'B', expr: lokiVitalExpr(service, otel.faroLoki.fcp, '[$__auto]'), legendFormat: 'FCP' },
        { refId: 'C', expr: lokiVitalExpr(service, otel.faroLoki.lcp, '[$__auto]'), legendFormat: 'LCP' },
      ],
    });
    const inpTrendQ = makeLokiQuery(lDs, lokiVitalExpr(service, otel.faroLoki.inp, '[$__auto]'), 'INP');
    const clsTrendQ = makeLokiQuery(lDs, lokiVitalExpr(service, otel.faroLoki.cls, '[$__auto]'), 'CLS');

    const trendsRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('Page Load Vitals')
            .setDescription('TTFB → FCP → LCP loading sequence over time')
            .setData(pageLoadVitalsQ)
            .setUnit('ms')
            .setCustomFieldConfig('thresholdsStyle', { mode: GraphThresholdsStyleMode.Area })
            .setThresholds({
              mode: ThresholdsMode.Absolute,
              steps: VITAL_THRESHOLDS.lcp,
            })
            .build(),
        }),
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('Interactivity (INP)')
            .setDescription('Interaction to Next Paint trend')
            .setData(inpTrendQ)
            .setUnit('ms')
            .setCustomFieldConfig('thresholdsStyle', { mode: GraphThresholdsStyleMode.Area })
            .setThresholds({
              mode: ThresholdsMode.Absolute,
              steps: VITAL_THRESHOLDS.inp,
            })
            .build(),
        }),
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('Layout Stability (CLS)')
            .setDescription('Cumulative Layout Shift trend')
            .setData(clsTrendQ)
            .setUnit('none')
            .setDecimals(3)
            .setCustomFieldConfig('thresholdsStyle', { mode: GraphThresholdsStyleMode.Area })
            .setThresholds({
              mode: ThresholdsMode.Absolute,
              steps: VITAL_THRESHOLDS.cls,
            })
            .build(),
        }),
      ],
    });

    // --- Row 3: Measurement count + JS Exceptions ---
    const measurementCountQ = makeLokiQuery(lDs, lokiMeasurementCountExpr(service, '[$__auto]'), 'Measurements');
    const exceptionCountQ = makeLokiQuery(lDs, lokiExceptionExpr(service, '[$__auto]'), 'JS Exceptions');

    const trafficRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('Web Vitals Measurements')
            .setDescription('Number of web vitals measurements over time')
            .setData(measurementCountQ)
            .setUnit('short')
            .setCustomFieldConfig('fillOpacity', 30)
            .build(),
        }),
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('JavaScript Exceptions')
            .setDescription('JS exception count over time')
            .setData(exceptionCountQ)
            .setUnit('short')
            .setCustomFieldConfig('fillOpacity', 15)
            .build(),
        }),
      ],
    });

    // --- Row 4: Per-Page Performance Table ---
    const pageUrl = otel.faroLoki.pageUrl;
    const perPageQ = new SceneQueryRunner({
      datasource: { uid: ds.logsUid, type: 'loki' },
      queries: [
        {
          refId: 'lcp',
          expr: lokiVitalByGroupExpr(service, otel.faroLoki.lcp, pageUrl, '[$__range]'),
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'fcp',
          expr: lokiVitalByGroupExpr(service, otel.faroLoki.fcp, pageUrl, '[$__range]'),
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'cls',
          expr: lokiVitalByGroupExpr(service, otel.faroLoki.cls, pageUrl, '[$__range]'),
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'count',
          expr: `sum by (${pageUrl}) (count_over_time(${lokiVitalPipeline(service, otel.faroLoki.lcp, pageUrl)} [$__range]))`,
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
      ],
    });
    const perPageData = new SceneDataTransformer({
      $data: perPageQ,
      transformations: [{ id: 'merge', options: {} }],
    });

    const perPageTable = new SceneFlexItem({
      minHeight: 250,
      body: PanelBuilders.table()
        .setTitle('Per-Page Performance')
        .setDescription('Average Web Vitals per page URL')
        .setData(perPageData)
        .setOverrides((b) => {
          b.matchFieldsWithName(pageUrl).overrideDisplayName('Page URL').overrideCustomFieldConfig('width', 400);
          b.matchFieldsWithName('Value #lcp')
            .overrideDisplayName('LCP (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.lcp })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #fcp')
            .overrideDisplayName('FCP (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.fcp })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #cls')
            .overrideDisplayName('CLS')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.cls })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(3);
          b.matchFieldsWithName('Value #count').overrideDisplayName('Measurements').overrideDecimals(0);
          b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
        })
        .build(),
    });

    // --- Row 5: Browser Breakdown Table ---
    const browserQ = new SceneQueryRunner({
      datasource: { uid: ds.logsUid, type: 'loki' },
      queries: [
        {
          refId: 'lcp',
          expr: lokiVitalByGroupExpr(service, otel.faroLoki.lcp, otel.faroLoki.browserName, '[$__range]'),
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'fcp',
          expr: lokiVitalByGroupExpr(service, otel.faroLoki.fcp, otel.faroLoki.browserName, '[$__range]'),
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'ttfb',
          expr: lokiVitalByGroupExpr(service, otel.faroLoki.ttfb, otel.faroLoki.browserName, '[$__range]'),
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
      ],
    });
    const browserData = new SceneDataTransformer({
      $data: browserQ,
      transformations: [{ id: 'merge', options: {} }],
    });

    const browserTable = new SceneFlexItem({
      minHeight: 250,
      body: PanelBuilders.table()
        .setTitle('Browser Breakdown')
        .setDescription('Average Web Vitals by browser')
        .setData(browserData)
        .setOverrides((b) => {
          b.matchFieldsWithName(otel.faroLoki.browserName).overrideDisplayName('Browser');
          b.matchFieldsWithName('Value #lcp')
            .overrideDisplayName('Avg LCP (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.lcp })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #fcp')
            .overrideDisplayName('Avg FCP (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.fcp })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #ttfb')
            .overrideDisplayName('Avg TTFB (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.ttfb })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
        })
        .build(),
    });

    // --- Row 5: Rating Distribution ---
    const fl = otel.faroLoki;
    const ratingStream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"}`;
    const ratingQ = makeLokiQuery(
      lDs,
      `sum by (${fl.rating}) (count_over_time(${ratingStream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" | ${fl.rating}!="" | keep ${fl.rating} [$__range]))`,
      `{{${fl.rating}}}`,
      { instant: true }
    );
    const ratingData = new SceneDataTransformer({
      $data: ratingQ,
      transformations: [
        {
          id: 'reduce',
          options: { reducers: ['sum'] },
        },
        {
          id: 'organize',
          options: {
            excludeByName: { Field: true },
            renameByName: { 'Sum': '' },
          },
        },
      ],
    });

    const ratingPanel = new SceneFlexItem({
      minHeight: 250,
      body: PanelBuilders.piechart()
        .setTitle('Web Vitals Rating Distribution')
        .setDescription('Distribution of good / needs-improvement / poor ratings')
        .setData(ratingData)
        .setOverrides((b) => {
          b.matchFieldsWithName('good').overrideColor({ mode: 'fixed', fixedColor: 'green' });
          b.matchFieldsWithName('needs-improvement').overrideColor({ mode: 'fixed', fixedColor: 'orange' });
          b.matchFieldsWithName('poor').overrideColor({ mode: 'fixed', fixedColor: 'red' });
        })
        .build(),
    });

    const bottomRow = new SceneFlexLayout({
      direction: 'row',
      children: [ratingPanel, browserTable],
    });

    // --- Row 6: Top Exceptions table ---
    const topExceptionsQ = new SceneQueryRunner({
      datasource: { uid: ds.logsUid, type: 'loki' },
      queries: [
        {
          refId: 'count',
          expr: lokiTopExceptionsExpr(service, '[$__range]'),
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'sessions',
          expr: lokiExceptionSessionsExpr(service, '[$__range]'),
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
      ],
    });
    const topExceptionsData = new SceneDataTransformer({
      $data: topExceptionsQ,
      transformations: [{ id: 'merge', options: {} }],
    });
    const topExceptionsPanel = new SceneFlexItem({
      minHeight: 300,
      body: PanelBuilders.table()
        .setTitle('Top Exceptions')
        .setDescription('Most frequent JS exceptions — click an error to explore in Loki')
        .setData(topExceptionsData)
        .setOverrides((b) => {
          b.matchFieldsWithName('value').overrideDisplayName('Error').overrideCustomFieldConfig('width', 500);
          b.matchFieldsWithName('Value #count').overrideDisplayName('Occurrences');
          b.matchFieldsWithName('Value #sessions').overrideDisplayName('Sessions Affected');
          b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
          b.matchFieldsWithName('value')
            .overrideLinks([
              {
                title: 'Explore in Loki',
                url: buildLokiExploreUrl(ds.logsUid, service, { from: '${__from:date:iso}', to: '${__to:date:iso}' })
                  + '&left=' + encodeURIComponent(JSON.stringify({
                    queries: [{
                      refId: 'A',
                      expr: `{${otel.faroLoki.serviceName}="${sanitizeLabelValue(service)}", ${otel.faroLoki.kind}="${otel.faroLoki.kindException}"} | logfmt | value=\`\${__data.fields.value}\``,
                    }],
                  })),
                targetBlank: true,
              } as any,
            ]);
        })
        .build(),
    });

    // --- Row 7: Sessions + Exceptions over time ---
    const sessionQ = makeLokiQuery(lDs, lokiSessionStartExpr(service, '[$__auto]'), 'Sessions');
    const sessionsAndExceptionsRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('Sessions (Visits)')
            .setDescription('New session starts over time — indicates user traffic volume')
            .setData(sessionQ)
            .setUnit('short')
            .setCustomFieldConfig('fillOpacity', 25)
            .setColor({ mode: 'fixed', fixedColor: 'blue' } as any)
            .build(),
        }),
        topExceptionsPanel,
      ],
    });

    // --- Row 8: Console Errors table ---
    const consoleErrorsQ = makeLokiQuery(lDs, lokiConsoleErrorsExpr(service, '[$__range]'), '{{value}}', {
      instant: true,
    });
    const consoleErrorsPanel = new SceneFlexItem({
      minHeight: 250,
      body: PanelBuilders.table()
        .setTitle('Console Errors')
        .setDescription('Most frequent console.error messages from Faro logs')
        .setData(consoleErrorsQ)
        .setOverrides((b) => {
          b.matchFieldsWithName('value').overrideDisplayName('Error Message');
          b.matchFieldsWithName('Value').overrideDisplayName('Count');
          b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
        })
        .build(),
    });

    const consoleErrorsRow = new SceneFlexLayout({
      direction: 'row',
      children: [consoleErrorsPanel],
    });

    return new EmbeddedScene({
      $timeRange: timeRange,
      $behaviors: [new behaviors.CursorSync({ sync: DashboardCursorSync.Crosshair })],
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [vitalsRow, trendsRow, trafficRow, perPageTable, bottomRow, sessionsAndExceptionsRow, consoleErrorsRow],
      }),
    });
  }, [from, to, ds, service]);

  return <scene.Component model={scene} />;
}

// ========================================================================
// Mimir-based Web Vitals panels (standard Prometheus/Faro metrics)
// ========================================================================

function MimirWebVitalsPanels({ service, namespace }: { service: string; namespace: string }) {
  const ds = usePluginDatasources();
  const { from, to } = useTimeRange();

  const svcFilter = `${otel.labels.serviceName}="${sanitizeLabelValue(service)}", ${otel.labels.serviceNamespace}="${sanitizeLabelValue(namespace)}"`;

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from, to });
    const mDs = { uid: ds.metricsUid };

    // --- Row 1: Core Web Vitals stat panels ---
    const lcpQ = makePromQuery(mDs, `avg(${otel.browser.lcp}{${svcFilter}})`, 'LCP');
    const fcpQ = makePromQuery(mDs, `avg(${otel.browser.fcp}{${svcFilter}})`, 'FCP');
    const clsQ = makePromQuery(mDs, `avg(${otel.browser.cls}{${svcFilter}})`, 'CLS');
    const inpQ = makePromQuery(mDs, `avg(${otel.browser.inp}{${svcFilter}})`, 'INP');
    const ttfbQ = makePromQuery(mDs, `avg(${otel.browser.ttfb}{${svcFilter}})`, 'TTFB');

    const vitalsRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('LCP', 'Largest Contentful Paint — target < 2500ms', lcpQ, 'ms', VITAL_THRESHOLDS.lcp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('FCP', 'First Contentful Paint — target < 1800ms', fcpQ, 'ms', VITAL_THRESHOLDS.fcp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('CLS', 'Cumulative Layout Shift — target < 0.1', clsQ, 'none', VITAL_THRESHOLDS.cls, 3),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('INP', 'Interaction to Next Paint — target < 200ms', inpQ, 'ms', VITAL_THRESHOLDS.inp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('TTFB', 'Time to First Byte — target < 800ms', ttfbQ, 'ms', VITAL_THRESHOLDS.ttfb),
        }),
      ],
    });

    // --- Row 2: Web Vitals time series ---
    const pageLoadVitalsQ = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [
        { refId: 'A', expr: `avg(${otel.browser.ttfb}{${svcFilter}})`, legendFormat: 'TTFB' },
        { refId: 'B', expr: `avg(${otel.browser.fcp}{${svcFilter}})`, legendFormat: 'FCP' },
        { refId: 'C', expr: `avg(${otel.browser.lcp}{${svcFilter}})`, legendFormat: 'LCP' },
      ],
    });
    const inpTrendQ = makePromQuery(mDs, `avg(${otel.browser.inp}{${svcFilter}})`, 'INP');
    const clsTrendQ = makePromQuery(mDs, `avg(${otel.browser.cls}{${svcFilter}})`, 'CLS');

    const trendsRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('Page Load Vitals')
            .setDescription('TTFB → FCP → LCP loading sequence over time')
            .setData(pageLoadVitalsQ)
            .setUnit('ms')
            .setCustomFieldConfig('thresholdsStyle', { mode: GraphThresholdsStyleMode.Area })
            .setThresholds({
              mode: ThresholdsMode.Absolute,
              steps: VITAL_THRESHOLDS.lcp,
            })
            .build(),
        }),
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('Interactivity (INP)')
            .setDescription('Interaction to Next Paint trend')
            .setData(inpTrendQ)
            .setUnit('ms')
            .setCustomFieldConfig('thresholdsStyle', { mode: GraphThresholdsStyleMode.Area })
            .setThresholds({
              mode: ThresholdsMode.Absolute,
              steps: VITAL_THRESHOLDS.inp,
            })
            .build(),
        }),
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('Layout Stability (CLS)')
            .setDescription('Cumulative Layout Shift trend')
            .setData(clsTrendQ)
            .setUnit('none')
            .setDecimals(3)
            .setCustomFieldConfig('thresholdsStyle', { mode: GraphThresholdsStyleMode.Area })
            .setThresholds({
              mode: ThresholdsMode.Absolute,
              steps: VITAL_THRESHOLDS.cls,
            })
            .build(),
        }),
      ],
    });

    // --- Row 3: Page Loads Over Time + JS Errors ---
    const pageLoadsQ = makePromQuery(
      mDs,
      `sum by (${otel.browser.pageRoute}) (increase(${otel.browser.pageLoads}{${svcFilter}}[$__rate_interval]))`,
      `{{${otel.browser.pageRoute}}}`,
      { minInterval: '1m' }
    );
    const errQ = makePromQuery(
      mDs,
      `sum(rate(${otel.browser.errors}{${svcFilter}}[$__rate_interval]))`,
      'JS Errors/s',
      { minInterval: '1m' }
    );

    const trafficRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('Page Loads Over Time')
            .setDescription('Page loads by route')
            .setData(pageLoadsQ)
            .setUnit('short')
            .setCustomFieldConfig('fillOpacity', 30)
            .setCustomFieldConfig('stacking', { mode: 'normal' as any })
            .build(),
        }),
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('JavaScript Errors')
            .setDescription('JS error rate over time')
            .setData(errQ)
            .setUnit('short')
            .setCustomFieldConfig('fillOpacity', 15)
            .build(),
        }),
      ],
    });

    // --- Row 4: Per-Page Performance Table ---
    const perPageQ = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [
        {
          refId: 'lcp',
          expr: `avg by (${otel.browser.pageRoute}) (${otel.browser.lcp}{${svcFilter}})`,
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'fcp',
          expr: `avg by (${otel.browser.pageRoute}) (${otel.browser.fcp}{${svcFilter}})`,
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'cls',
          expr: `avg by (${otel.browser.pageRoute}) (${otel.browser.cls}{${svcFilter}})`,
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'inp',
          expr: `avg by (${otel.browser.pageRoute}) (${otel.browser.inp}{${svcFilter}})`,
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'ttfb',
          expr: `avg by (${otel.browser.pageRoute}) (${otel.browser.ttfb}{${svcFilter}})`,
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'loads',
          expr: `sum by (${otel.browser.pageRoute}) (increase(${otel.browser.pageLoads}{${svcFilter}}[$__range]))`,
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
      ],
    });
    const perPageData = new SceneDataTransformer({
      $data: perPageQ,
      transformations: [{ id: 'merge', options: {} }],
    });

    const perPageTable = new SceneFlexItem({
      minHeight: 250,
      body: PanelBuilders.table()
        .setTitle('Per-Page Performance')
        .setDescription('Average Web Vitals per page route')
        .setData(perPageData)
        .setOverrides((b) => {
          b.matchFieldsWithName('Value #lcp')
            .overrideDisplayName('LCP (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.lcp })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #fcp')
            .overrideDisplayName('FCP (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.fcp })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #cls')
            .overrideDisplayName('CLS')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.cls })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(3);
          b.matchFieldsWithName('Value #inp')
            .overrideDisplayName('INP (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.inp })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #ttfb')
            .overrideDisplayName('TTFB (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.ttfb })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #loads').overrideDisplayName('Page Loads').overrideDecimals(0);
          b.matchFieldsWithName('page_route').overrideDisplayName('Page Route');
          b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
        })
        .build(),
    });

    // --- Row 5: Browser Breakdown ---
    const browserQ = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [
        {
          refId: 'lcp',
          expr: `avg by (${otel.browser.browserName}) (${otel.browser.lcp}{${svcFilter}})`,
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'loads',
          expr: `sum by (${otel.browser.browserName}) (increase(${otel.browser.pageLoads}{${svcFilter}}[$__range]))`,
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'errors',
          expr: `sum by (${otel.browser.browserName}) (increase(${otel.browser.errors}{${svcFilter}, ${otel.browser.browserName}!=""}[$__range]))`,
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
      ],
    });
    const browserData = new SceneDataTransformer({
      $data: browserQ,
      transformations: [{ id: 'merge', options: {} }],
    });

    const browserTable = new SceneFlexItem({
      minHeight: 200,
      body: PanelBuilders.table()
        .setTitle('Browser Breakdown')
        .setDescription('Performance and error metrics by browser')
        .setData(browserData)
        .setOverrides((b) => {
          b.matchFieldsWithName('browser_name').overrideDisplayName('Browser');
          b.matchFieldsWithName('Value #lcp')
            .overrideDisplayName('Avg LCP (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.lcp })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #loads').overrideDisplayName('Page Loads').overrideDecimals(0);
          b.matchFieldsWithName('Value #errors').overrideDisplayName('JS Errors').overrideDecimals(0);
          b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
        })
        .build(),
    });

    // --- Row 6: Page Load Duration Histogram ---
    const pageLoadHistQ = makePromQuery(
      mDs,
      `sum by (${otel.labels.le}) (increase(${otel.browser.pageLoadDuration}{${svcFilter}}[$__range]))`,
      '{{le}}',
      { format: 'heatmap' }
    );

    const histogramItem = new SceneFlexItem({
      minHeight: 250,
      body: PanelBuilders.histogram()
        .setTitle('Page Load Duration Distribution')
        .setDescription('Distribution of page load durations')
        .setData(pageLoadHistQ)
        .setUnit('ms')
        .build(),
    });

    const bottomRow = new SceneFlexLayout({
      direction: 'row',
      children: [histogramItem, browserTable],
    });

    return new EmbeddedScene({
      $timeRange: timeRange,
      $behaviors: [new behaviors.CursorSync({ sync: DashboardCursorSync.Crosshair })],
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [vitalsRow, trendsRow, trafficRow, perPageTable, bottomRow],
      }),
    });
  }, [from, to, ds, svcFilter]);

  return <scene.Component model={scene} />;
}

// ---- Setup placeholder (no Faro data) ----

function SetupPlaceholder({ namespace, service }: { namespace: string; service: string }) {
  const styles = useStyles2(getStyles);

  return (
    <div className={styles.container}>
      <Alert severity="info" title="Frontend Observability">
        <p>
          No browser telemetry data found for{' '}
          <strong>
            {namespace}/{service}
          </strong>
          .
        </p>
        <p>
          Instrument your web application with{' '}
          <a href="https://grafana.com/docs/faro-web-sdk/latest/" target="_blank" rel="noopener noreferrer">
            Grafana Faro Web SDK
          </a>{' '}
          or the{' '}
          <a
            href="https://opentelemetry.io/docs/languages/js/getting-started/browser/"
            target="_blank"
            rel="noopener noreferrer"
          >
            OpenTelemetry Browser SDK
          </a>{' '}
          to collect Web Vitals, JS errors, and page load data.
        </p>
      </Alert>

      <div className={styles.features}>
        <h4 className={styles.featuresTitle}>
          <Icon name="info-circle" /> What you&apos;ll see with frontend instrumentation
        </h4>
        <div className={styles.featureGrid}>
          <FeatureCard
            icon="dashboard"
            title="Core Web Vitals"
            description="LCP, FCP, CLS, INP, TTFB — real user experience metrics"
          />
          <FeatureCard
            icon="bug"
            title="JavaScript Errors"
            description="Error rates, stack traces, and error grouping"
          />
          <FeatureCard
            icon="clock-nine"
            title="Page Load Performance"
            description="Navigation timing and time-to-interactive"
          />
          <FeatureCard
            icon="gf-traces"
            title="Frontend Traces"
            description="Distributed traces from browser → backend"
          />
        </div>
      </div>

      <LinkButton
        href="https://grafana.com/docs/faro-web-sdk/latest/tutorials/quick-start-browser/"
        target="_blank"
        variant="secondary"
        icon="external-link-alt"
        size="sm"
      >
        Faro Quick Start Guide
      </LinkButton>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: string; title: string; description: string }) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.card}>
      <Icon name={icon as any} size="lg" className={styles.cardIcon} />
      <div>
        <div className={styles.cardTitle}>{title}</div>
        <div className={styles.cardDescription}>{description}</div>
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(3)};
  `,
  features: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1.5)};
    max-width: 800px;
  `,
  featuresTitle: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    margin: 0;
  `,
  featureGrid: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: ${theme.spacing(2)};
    @media (max-width: 600px) {
      grid-template-columns: 1fr;
    }
  `,
  card: css`
    display: flex;
    gap: ${theme.spacing(1.5)};
    padding: ${theme.spacing(2)};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
  `,
  cardIcon: css`
    color: ${theme.colors.text.secondary};
    flex-shrink: 0;
    margin-top: 2px;
  `,
  cardTitle: css`
    font-weight: ${theme.typography.fontWeightMedium};
    margin-bottom: 4px;
  `,
  cardDescription: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
});
