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
  SceneVariableSet,
  CustomVariable,
  VariableValueSelectors,
  PanelBuilders,
  EmbeddedScene,
  SceneReactObject,
  behaviors,
} from '@grafana/scenes';
import { DashboardCursorSync, GraphThresholdsStyleMode } from '@grafana/schema';
import { getFrontendMetrics } from '../../api/client';
import { usePluginDatasources } from '../../utils/datasources';
import { useTimeRange } from '../../utils/timeRange';
import { sanitizeLabelValue } from '../../utils/sanitize';
import { otel } from '../../otelconfig';

import {
  VITAL_THRESHOLDS,
  WebVitalsBullets,
  buildStatPanel,
  makePromQuery,
  histogramFilter,
  buildInsightsSection,
  buildTrendsSection,
  buildPerPageSection,
  buildErrorsSection,
  buildSupportSection,
  buildTrafficSection,
  type FrontendSceneContext,
} from './frontend';

interface FrontendTabProps {
  service: string;
  namespace: string;
  environment?: string;
}

type FrontendSource = 'mimir' | 'loki' | 'alloy' | 'alloy-histogram';

export function FrontendTab({ service, namespace, environment }: FrontendTabProps) {
  const styles = useStyles2(getStyles);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [source, setSource] = useState<FrontendSource | null>(null);
  const [hasLoki, setHasLoki] = useState<boolean>(false);
  const [vitals, setVitals] = useState<Record<string, number> | undefined>();

  useEffect(() => {
    let cancelled = false;

    getFrontendMetrics(namespace, service, environment || undefined)
      .then((r) => {
        if (cancelled) {
          return;
        }
        setAvailable(r.available);
        setSource((r.source as FrontendSource) ?? null);
        setHasLoki(r.hasLoki ?? false);
        setVitals(r.vitals);
      })
      .catch(() => {
        if (!cancelled) {
          setAvailable(false);
          setSource(null);
          setHasLoki(false);
          setVitals(undefined);
        }
      });

    return () => {
      cancelled = true;
      setAvailable(null);
      setSource(null);
      setHasLoki(false);
      setVitals(undefined);
    };
  }, [service, namespace, environment]);

  if (available === null) {
    return <LoadingPlaceholder text="Checking for browser telemetry..." />;
  }

  if (!available || !source) {
    return <SetupPlaceholder namespace={namespace} service={service} />;
  }

  // Detect "instrumented but no recent data" — available=true with source set but no vitals
  const noRecentData = !vitals || Object.keys(vitals).length === 0;

  // hasAllVitals only needed for legacy Mimir/Alloy views that still use conditional stat panels
  const REQUIRED_VITALS = ['lcp', 'fcp', 'cls', 'inp', 'ttfb'];
  const hasAllVitals = vitals != null && REQUIRED_VITALS.every((k) => k in vitals);

  return (
    <div className={styles.container}>
      {noRecentData && (
        <Alert severity="info" title="No recent measurements">
          This service is instrumented but has no browser telemetry in the current time range. Try widening the time
          range or wait for new traffic.
        </Alert>
      )}
      {(source === 'loki' || source === 'alloy-histogram') && (
        <UnifiedFrontendPanels
          source={source}
          service={service}
          namespace={namespace}
          environment={environment}
          vitals={vitals}
          hasLoki={hasLoki}
        />
      )}
      {source === 'mimir' && (
        <MimirWebVitalsPanels
          service={service}
          namespace={namespace}
          environment={environment}
          showVitalsRow={!hasAllVitals}
          vitals={hasAllVitals ? vitals : undefined}
        />
      )}
      {source === 'alloy' && (
        <AlloyWebVitalsPanels
          service={service}
          environment={environment}
          showVitalsRow={!hasAllVitals}
          vitals={hasAllVitals ? vitals : undefined}
        />
      )}
    </div>
  );
}

// ========================================================================
// Unified Frontend Panels — one layout for both histogram (Mimir) and Loki sources.
// Section builders handle the per-source query construction; this component
// composes them into an EmbeddedScene with shared time range and variables.
// ========================================================================

function UnifiedFrontendPanels({
  source,
  service,
  namespace,
  environment,
  vitals,
  hasLoki,
}: {
  source: 'loki' | 'alloy-histogram';
  service: string;
  namespace: string;
  environment?: string;
  vitals?: Record<string, number>;
  hasLoki: boolean;
}) {
  const ds = usePluginDatasources(environment || undefined);
  const { from, to } = useTimeRange();

  const ah = otel.alloyHistogram;
  const isHistogram = source === 'alloy-histogram';
  const showLokiPanels = hasLoki || source === 'loki';
  const svcFilter = isHistogram
    ? histogramFilter(sanitizeLabelValue(service), environment ? sanitizeLabelValue(environment) : undefined)
    : '';

  const scene = useMemo(() => {
    const ctx: FrontendSceneContext = {
      metricsDs: { uid: ds.metricsUid },
      logsDs: { uid: ds.logsUid },
      service,
      namespace,
      environment,
      svcFilter,
      isHistogram,
      showLokiPanels,
      ah,
    };

    const timeRange = new SceneTimeRange({ from, to });

    // Build sections using capability-gated builders
    const insightsRow = buildInsightsSection(ctx);
    const trendsRow = buildTrendsSection(ctx);
    const perPageTable = buildPerPageSection(ctx);
    const errorsRow = buildErrorsSection(ctx);
    const supportRow = buildSupportSection(ctx);
    const trafficRow = buildTrafficSection(ctx);

    // Browser filter variable
    const browserVar = new CustomVariable({
      name: 'browser',
      label: 'Browser',
      isMulti: false,
      includeAll: true,
      allValue: '.*',
      query: 'Chrome,Firefox,Safari,Edge,Opera,Samsung Internet',
      value: '',
    });

    // Bullet chart summary (pre-computed by backend)
    const bulletsItem = vitals
      ? new SceneFlexItem({
          body: new SceneReactObject({ reactNode: <WebVitalsBullets vitals={vitals} /> }),
        })
      : null;

    return new EmbeddedScene({
      $timeRange: timeRange,
      $variables: new SceneVariableSet({ variables: [browserVar] }),
      $behaviors: [new behaviors.CursorSync({ sync: DashboardCursorSync.Crosshair })],
      controls: [new VariableValueSelectors({}), new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          ...(bulletsItem ? [bulletsItem] : []),
          ...(insightsRow ? [insightsRow] : []),
          trendsRow,
          ...(errorsRow ? [errorsRow] : []),
          ...(perPageTable ? [perPageTable] : []),
          trafficRow,
          ...(supportRow ? [supportRow] : []),
        ],
      }),
    });
  }, [from, to, ds, service, namespace, environment, svcFilter, ah, isHistogram, showLokiPanels, vitals]);

  return <scene.Component model={scene} />;
}

// ========================================================================
// Mimir-based Web Vitals panels (standard Prometheus/Faro metrics)
// ========================================================================

function MimirWebVitalsPanels({
  service,
  namespace,
  environment,
  showVitalsRow = true,
  vitals,
}: {
  service: string;
  namespace: string;
  environment?: string;
  showVitalsRow?: boolean;
  vitals?: Record<string, number>;
}) {
  const ds = usePluginDatasources(environment || undefined);
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
          body: buildStatPanel('LCP', 'Largest Contentful Paint — target < 2500ms', lcpQ, 'ms', VITAL_THRESHOLDS.lcp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: buildStatPanel('FCP', 'First Contentful Paint — target < 1800ms', fcpQ, 'ms', VITAL_THRESHOLDS.fcp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: buildStatPanel('CLS', 'Cumulative Layout Shift — target < 0.1', clsQ, 'none', VITAL_THRESHOLDS.cls, 3),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: buildStatPanel('INP', 'Interaction to Next Paint — target < 200ms', inpQ, 'ms', VITAL_THRESHOLDS.inp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: buildStatPanel('TTFB', 'Time to First Byte — target < 800ms', ttfbQ, 'ms', VITAL_THRESHOLDS.ttfb),
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

    const bulletsItem = vitals
      ? new SceneFlexItem({
          body: new SceneReactObject({ reactNode: <WebVitalsBullets vitals={vitals} /> }),
        })
      : null;

    return new EmbeddedScene({
      $timeRange: timeRange,
      $behaviors: [new behaviors.CursorSync({ sync: DashboardCursorSync.Crosshair })],
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          ...(bulletsItem ? [bulletsItem] : []),
          ...(showVitalsRow ? [vitalsRow] : []),
          trendsRow,
          trafficRow,
          perPageTable,
          bottomRow,
        ],
      }),
    });
  }, [from, to, ds, svcFilter, showVitalsRow, vitals]);

  return <scene.Component model={scene} />;
}

// ========================================================================
// Alloy Faro pipeline panels (loki_process_custom_* metrics in Mimir)
// ========================================================================

function AlloyWebVitalsPanels({
  service,
  environment,
  showVitalsRow = true,
  vitals,
}: {
  service: string;
  environment?: string;
  showVitalsRow?: boolean;
  vitals?: Record<string, number>;
}) {
  const ds = usePluginDatasources(environment || undefined);
  const { from, to } = useTimeRange();

  const ab = otel.alloyBrowser;
  const envLabel = otel.labels.deploymentEnv;
  const svcFilter = environment
    ? `${ab.appLabel}="${sanitizeLabelValue(service)}", job="${ab.job}", ${envLabel}="${sanitizeLabelValue(environment)}"`
    : `${ab.appLabel}="${sanitizeLabelValue(service)}", job="${ab.job}"`;
  const lookback = ab.lookback;

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from, to });
    const mDs = { uid: ds.metricsUid };

    // --- Row 1: Core Web Vitals stat panels (avg_over_time for sparse gauge samples) ---
    const lcpQ = makePromQuery(mDs, `avg(avg_over_time(${ab.lcp}{${svcFilter}}[${lookback}]))`, 'LCP', {
      instant: true,
    });
    const fcpQ = makePromQuery(mDs, `avg(avg_over_time(${ab.fcp}{${svcFilter}}[${lookback}]))`, 'FCP', {
      instant: true,
    });
    const clsQ = makePromQuery(mDs, `avg(avg_over_time(${ab.cls}{${svcFilter}}[${lookback}]))`, 'CLS', {
      instant: true,
    });
    const inpQ = makePromQuery(mDs, `avg(avg_over_time(${ab.inp}{${svcFilter}}[${lookback}]))`, 'INP', {
      instant: true,
    });
    const ttfbQ = makePromQuery(mDs, `avg(avg_over_time(${ab.ttfb}{${svcFilter}}[${lookback}]))`, 'TTFB', {
      instant: true,
    });

    const vitalsRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({
          minHeight: 130,
          body: buildStatPanel('LCP', 'Largest Contentful Paint — target < 2500ms', lcpQ, 'ms', VITAL_THRESHOLDS.lcp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: buildStatPanel('FCP', 'First Contentful Paint — target < 1800ms', fcpQ, 'ms', VITAL_THRESHOLDS.fcp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: buildStatPanel('CLS', 'Cumulative Layout Shift — target < 0.1', clsQ, 'none', VITAL_THRESHOLDS.cls, 3),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: buildStatPanel('INP', 'Interaction to Next Paint — target < 200ms', inpQ, 'ms', VITAL_THRESHOLDS.inp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: buildStatPanel('TTFB', 'Time to First Byte — target < 800ms', ttfbQ, 'ms', VITAL_THRESHOLDS.ttfb),
        }),
      ],
    });

    // --- Row 2: Web Vitals time series (range vectors with avg_over_time) ---
    const pageLoadVitalsQ = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [
        {
          refId: 'A',
          expr: `avg(avg_over_time(${ab.ttfb}{${svcFilter}}[${lookback}]))`,
          legendFormat: 'TTFB',
        },
        {
          refId: 'B',
          expr: `avg(avg_over_time(${ab.fcp}{${svcFilter}}[${lookback}]))`,
          legendFormat: 'FCP',
        },
        {
          refId: 'C',
          expr: `avg(avg_over_time(${ab.lcp}{${svcFilter}}[${lookback}]))`,
          legendFormat: 'LCP',
        },
      ],
    });
    const inpTrendQ = makePromQuery(mDs, `avg(avg_over_time(${ab.inp}{${svcFilter}}[${lookback}]))`, 'INP');
    const clsTrendQ = makePromQuery(mDs, `avg(avg_over_time(${ab.cls}{${svcFilter}}[${lookback}]))`, 'CLS');

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

    // --- Row 3: Page Loads + JS Errors over time ---
    const pageLoadsQ = makePromQuery(mDs, `sum(rate(${ab.pageLoads}{${svcFilter}}[${lookback}]))`, 'Page Loads/s', {
      minInterval: '1m',
    });
    const errQ = makePromQuery(mDs, `sum(rate(${ab.errors}{${svcFilter}}[${lookback}]))`, 'JS Errors/s', {
      minInterval: '1m',
    });

    const trafficRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('Page Loads')
            .setDescription('Page load rate over time')
            .setData(pageLoadsQ)
            .setUnit('short')
            .setCustomFieldConfig('fillOpacity', 30)
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

    const bulletsItem = vitals
      ? new SceneFlexItem({
          body: new SceneReactObject({ reactNode: <WebVitalsBullets vitals={vitals} /> }),
        })
      : null;

    return new EmbeddedScene({
      $timeRange: timeRange,
      $behaviors: [new behaviors.CursorSync({ sync: DashboardCursorSync.Crosshair })],
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [...(bulletsItem ? [bulletsItem] : []), ...(showVitalsRow ? [vitalsRow] : []), trendsRow, trafficRow],
      }),
    });
  }, [from, to, ds, svcFilter, lookback, ab, showVitalsRow, vitals]);

  return (
    <>
      <Alert title="Limited data source" severity="info">
        Using Alloy pipeline metrics (sampled). Values are averaged from a small number of gauge samples and may differ
        from the full measurement population.
      </Alert>
      <scene.Component model={scene} />
    </>
  );
}

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
