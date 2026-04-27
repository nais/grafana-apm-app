/**
 * Section builders for the Unified Frontend dashboard.
 *
 * Each function builds one logical section (row) of the dashboard given
 * a FrontendSceneContext. Returns a SceneFlexLayout or SceneFlexItem,
 * or null if the section should not render for the current capabilities.
 */
import { SceneFlexLayout, SceneFlexItem, SceneQueryRunner, SceneDataTransformer, PanelBuilders } from '@grafana/scenes';
import { ThresholdsMode, GraphThresholdsStyleMode, StackingMode, VizOrientation } from '@grafana/schema';

import { otel } from '../../../otelconfig';
import { sanitizeLabelValue } from '../../../utils/sanitize';
import { PLUGIN_BASE_URL } from '../../../constants';
import { VITAL_THRESHOLDS, BROWSER_FILTER, CWV_BUCKET_BOUNDARIES, VitalKey } from './constants';
import { makePromQuery, makeLokiQuery, normalizePageUrlExpr } from './panel-helpers';
import {
  lokiVitalExpr,
  lokiVitalByGroupExpr,
  lokiVitalByPageExpr,
  lokiTopExceptionsExpr,
  lokiExceptionSessionsExpr,
  lokiExceptionExpr,
  lokiSessionStartExpr,
  lokiConsoleErrorsExpr,
  lokiMeasurementCountExpr,
} from './queries/loki-builders';
import { FrontendSceneContext } from './scene-context';

// ---------------------------------------------------------------------------
// Section 1: Histogram Insights (CWV Rating Breakdown + Navigation Type)
// Only shown when source is alloy-histogram.
// ---------------------------------------------------------------------------

/** Build CWV Rating Breakdown + Navigation Type row (histogram-only). */
export function buildInsightsSection(ctx: FrontendSceneContext): SceneFlexLayout | null {
  if (!ctx.isHistogram) {
    return null;
  }

  const { metricsDs, svcFilter, ah } = ctx;
  const vitals: VitalKey[] = ['lcp', 'fcp', 'cls', 'inp', 'ttfb'];

  // Build rating queries for each vital (good/needs-improvement/poor)
  const ratingQueries = vitals.flatMap((vital) => {
    const metric = ah[vital];
    const { good, poor } = CWV_BUCKET_BOUNDARIES[vital];
    const label = vital.toUpperCase();
    return [
      {
        refId: `${vital}_good`,
        expr: `increase(${metric}_bucket{${svcFilter}, le="${good}"}[$__range]) / increase(${metric}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
        legendFormat: `${label} Good`,
        instant: true,
      },
      {
        refId: `${vital}_ni`,
        expr: `(increase(${metric}_bucket{${svcFilter}, le="${poor}"}[$__range]) - increase(${metric}_bucket{${svcFilter}, le="${good}"}[$__range])) / increase(${metric}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
        legendFormat: `${label} Needs Improvement`,
        instant: true,
      },
      {
        refId: `${vital}_poor`,
        expr: `1 - increase(${metric}_bucket{${svcFilter}, le="${poor}"}[$__range]) / increase(${metric}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
        legendFormat: `${label} Poor`,
        instant: true,
      },
    ];
  });

  const cwvRatingQ = new SceneQueryRunner({
    datasource: { uid: metricsDs.uid, type: 'prometheus' },
    queries: ratingQueries,
  });

  const cwvRatingPanel = new SceneFlexItem({
    minHeight: 200,
    body: PanelBuilders.barchart()
      .setTitle('CWV Rating Breakdown')
      .setDescription('Percentage of page loads rated Good / Needs Improvement / Poor per Core Web Vital')
      .setData(cwvRatingQ)
      .setUnit('percentunit')
      .setOption('stacking', StackingMode.Normal)
      .setOption('orientation', VizOrientation.Horizontal)
      .setOverrides((b) => {
        for (const v of vitals) {
          b.matchFieldsByQuery(`${v}_good`).overrideColor({ mode: 'fixed', fixedColor: 'green' });
          b.matchFieldsByQuery(`${v}_ni`).overrideColor({ mode: 'fixed', fixedColor: 'orange' });
          b.matchFieldsByQuery(`${v}_poor`).overrideColor({ mode: 'fixed', fixedColor: 'red' });
        }
      })
      .build(),
  });

  // Navigation Type — 100% stacked timeseries
  const navTypeQ = makePromQuery(
    metricsDs,
    `sum by (${ah.navTypeLabel}) (rate(${ah.pageLoadsByNav}{${svcFilter}}[$__rate_interval]))`,
    `{{${ah.navTypeLabel}}}`
  );
  const navTypePanel = new SceneFlexItem({
    minHeight: 200,
    body: PanelBuilders.timeseries()
      .setTitle('Navigation Type')
      .setDescription('Page load distribution by navigation type (navigate, reload, back/forward)')
      .setData(navTypeQ)
      .setUnit('short')
      .setCustomFieldConfig('fillOpacity', 80)
      .setCustomFieldConfig('stacking', { mode: 'percent' as any })
      .setOverrides((b) => {
        b.matchFieldsWithName('navigate').overrideColor({ mode: 'fixed', fixedColor: 'blue' });
        b.matchFieldsWithName('reload').overrideColor({ mode: 'fixed', fixedColor: 'orange' });
        b.matchFieldsWithName('back_forward').overrideColor({ mode: 'fixed', fixedColor: 'purple' });
        b.matchFieldsWithName('prerender').overrideColor({ mode: 'fixed', fixedColor: 'green' });
      })
      .build(),
  });

  return new SceneFlexLayout({
    direction: 'row',
    children: [cwvRatingPanel, navTypePanel],
  });
}

// ---------------------------------------------------------------------------
// Section 2: Web Vitals Trends (TTFB → FCP → LCP timeseries + INP + CLS)
// ---------------------------------------------------------------------------

/** Build Web Vitals trends timeseries row. */
export function buildTrendsSection(ctx: FrontendSceneContext): SceneFlexLayout {
  const { metricsDs, logsDs, service, svcFilter, ah, isHistogram } = ctx;
  const fl = otel.faroLoki;

  let pageLoadVitalsQ: SceneQueryRunner;
  let inpTrendQ: SceneQueryRunner;
  let clsTrendQ: SceneQueryRunner;

  if (isHistogram) {
    pageLoadVitalsQ = new SceneQueryRunner({
      datasource: { uid: metricsDs.uid, type: 'prometheus' },
      queries: [
        {
          refId: 'A',
          expr: `histogram_quantile(0.75, sum(rate(${ah.ttfb}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
          legendFormat: 'TTFB',
        },
        {
          refId: 'B',
          expr: `histogram_quantile(0.75, sum(rate(${ah.fcp}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
          legendFormat: 'FCP',
        },
        {
          refId: 'C',
          expr: `histogram_quantile(0.75, sum(rate(${ah.lcp}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
          legendFormat: 'LCP',
        },
      ],
    });
    inpTrendQ = makePromQuery(
      metricsDs,
      `histogram_quantile(0.75, sum(rate(${ah.inp}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
      'INP'
    );
    clsTrendQ = makePromQuery(
      metricsDs,
      `histogram_quantile(0.75, sum(rate(${ah.cls}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
      'CLS'
    );
  } else {
    pageLoadVitalsQ = new SceneQueryRunner({
      datasource: { uid: logsDs.uid, type: 'loki' },
      queries: [
        { refId: 'A', expr: lokiVitalExpr(service, fl.ttfb, '[$__auto]'), legendFormat: 'TTFB' },
        { refId: 'B', expr: lokiVitalExpr(service, fl.fcp, '[$__auto]'), legendFormat: 'FCP' },
        { refId: 'C', expr: lokiVitalExpr(service, fl.lcp, '[$__auto]'), legendFormat: 'LCP' },
      ],
    });
    inpTrendQ = makeLokiQuery(logsDs, lokiVitalExpr(service, fl.inp, '[$__auto]'), 'INP');
    clsTrendQ = makeLokiQuery(logsDs, lokiVitalExpr(service, fl.cls, '[$__auto]'), 'CLS');
  }

  const trendTitle = isHistogram ? 'p75' : 'avg';

  return new SceneFlexLayout({
    direction: 'row',
    children: [
      new SceneFlexItem({
        minHeight: 200,
        body: PanelBuilders.timeseries()
          .setTitle(`Page Load Vitals (${trendTitle})`)
          .setDescription('TTFB → FCP → LCP loading sequence over time')
          .setData(pageLoadVitalsQ)
          .setUnit('ms')
          .build(),
      }),
      new SceneFlexItem({
        minHeight: 200,
        body: PanelBuilders.timeseries()
          .setTitle(`Interactivity (INP ${trendTitle})`)
          .setDescription('Interaction to Next Paint trend')
          .setData(inpTrendQ)
          .setUnit('ms')
          .setCustomFieldConfig('thresholdsStyle', { mode: GraphThresholdsStyleMode.Area })
          .setThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.inp })
          .build(),
      }),
      new SceneFlexItem({
        minHeight: 200,
        body: PanelBuilders.timeseries()
          .setTitle(`Layout Stability (CLS ${trendTitle})`)
          .setDescription('Cumulative Layout Shift trend')
          .setData(clsTrendQ)
          .setUnit('none')
          .setDecimals(3)
          .setCustomFieldConfig('thresholdsStyle', { mode: GraphThresholdsStyleMode.Area })
          .setThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.cls })
          .build(),
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Section 3: Per-Page Performance Table (Loki-only)
// ---------------------------------------------------------------------------

/** Build per-page performance table (requires Loki). */
export function buildPerPageSection(ctx: FrontendSceneContext): SceneFlexItem | null {
  if (!ctx.showLokiPanels) {
    return null;
  }

  const { logsDs, service } = ctx;
  const fl = otel.faroLoki;
  const pageUrl = fl.pageUrl;

  const countPipeline = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" | ${pageUrl}!="" | keep ${pageUrl}`;

  const perPageQ = new SceneQueryRunner({
    datasource: { uid: logsDs.uid, type: 'loki' },
    queries: [
      {
        refId: 'lcp',
        expr: lokiVitalByPageExpr(service, fl.lcp, pageUrl, '[$__range]'),
        legendFormat: '__auto',
        format: 'table',
        instant: true,
      },
      {
        refId: 'fcp',
        expr: lokiVitalByPageExpr(service, fl.fcp, pageUrl, '[$__range]'),
        legendFormat: '__auto',
        format: 'table',
        instant: true,
      },
      {
        refId: 'cls',
        expr: lokiVitalByPageExpr(service, fl.cls, pageUrl, '[$__range]'),
        legendFormat: '__auto',
        format: 'table',
        instant: true,
      },
      {
        refId: 'inp',
        expr: lokiVitalByPageExpr(service, fl.inp, pageUrl, '[$__range]'),
        legendFormat: '__auto',
        format: 'table',
        instant: true,
      },
      {
        refId: 'count',
        expr: normalizePageUrlExpr(`sum by (${pageUrl}) (count_over_time(${countPipeline} [$__range]))`, pageUrl),
        legendFormat: '__auto',
        format: 'table',
        instant: true,
      },
    ],
  });

  const perPageData = new SceneDataTransformer({
    $data: perPageQ,
    transformations: [
      { id: 'merge', options: {} },
      { id: 'sortBy', options: { sort: [{ field: 'Value #count', desc: true }] } },
    ],
  });

  return new SceneFlexItem({
    minHeight: 300,
    body: PanelBuilders.table()
      .setTitle('Per-Page Performance')
      .setDescription('Average Web Vitals broken down by page URL (top pages by traffic)')
      .setData(perPageData)
      .setOverrides((b) => {
        b.matchFieldsWithName(pageUrl).overrideDisplayName('Page').overrideCustomFieldConfig('width', 350);
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
        b.matchFieldsWithName('Value #cls')
          .overrideDisplayName('Avg CLS')
          .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.cls })
          .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
          .overrideDecimals(3);
        b.matchFieldsWithName('Value #inp')
          .overrideDisplayName('Avg INP (ms)')
          .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.inp })
          .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
          .overrideDecimals(0);
        b.matchFieldsWithName('Value #ttfb')
          .overrideDisplayName('Avg TTFB (ms)')
          .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.ttfb })
          .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
          .overrideDecimals(0);
        b.matchFieldsWithName('Value #count').overrideDisplayName('Measurements').overrideDecimals(0);
        b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
      })
      .build(),
  });
}

// ---------------------------------------------------------------------------
// Section 4: Errors Row (Top Exceptions + Browser Breakdown + optional Volume)
// ---------------------------------------------------------------------------

/** Build errors row with exceptions table, browser breakdown, and optional volume pie. */
export function buildErrorsSection(ctx: FrontendSceneContext): SceneFlexLayout | null {
  if (!ctx.showLokiPanels) {
    return null;
  }

  const { logsDs, metricsDs, service, namespace, svcFilter, ah, isHistogram } = ctx;
  const fl = otel.faroLoki;

  // Top Exceptions table
  const topExceptionsQ = new SceneQueryRunner({
    datasource: { uid: logsDs.uid, type: 'loki' },
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
      .setDescription('Most frequent JS exceptions — click to view in Logs tab')
      .setData(topExceptionsData)
      .setOverrides((b) => {
        b.matchFieldsWithName('value').overrideDisplayName('Error').overrideCustomFieldConfig('width', 500);
        b.matchFieldsWithName('Value #count').overrideDisplayName('Occurrences');
        b.matchFieldsWithName('Value #sessions').overrideDisplayName('Sessions Affected');
        b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
        b.matchFieldsWithName('value').overrideLinks([
          {
            title: 'View in Logs',
            url: `${PLUGIN_BASE_URL}/services/${encodeURIComponent(namespace)}/${encodeURIComponent(service)}/logs?from=\${__from}&to=\${__to}`,
            targetBlank: false,
          } as any,
        ]);
      })
      .build(),
  });

  // Browser breakdown table (Loki vitals per browser)
  const browserQ = new SceneQueryRunner({
    datasource: { uid: logsDs.uid, type: 'loki' },
    queries: [
      {
        refId: 'lcp',
        expr: lokiVitalByGroupExpr(service, fl.lcp, fl.browserName, '[$__range]'),
        legendFormat: '__auto',
        format: 'table',
        instant: true,
      },
      {
        refId: 'fcp',
        expr: lokiVitalByGroupExpr(service, fl.fcp, fl.browserName, '[$__range]'),
        legendFormat: '__auto',
        format: 'table',
        instant: true,
      },
      {
        refId: 'ttfb',
        expr: lokiVitalByGroupExpr(service, fl.ttfb, fl.browserName, '[$__range]'),
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
      .setDescription('Average Web Vitals by browser' + (isHistogram ? ' (volume from Mimir)' : ''))
      .setData(browserData)
      .setOverrides((b) => {
        b.matchFieldsWithName(fl.browserName).overrideDisplayName('Browser');
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

  // Optional browser volume pie (histogram source only)
  const children: SceneFlexItem[] = [topExceptionsPanel, browserTable];
  if (isHistogram) {
    const browserVolumeQ = new SceneQueryRunner({
      datasource: { uid: metricsDs.uid, type: 'prometheus' },
      queries: [
        {
          refId: 'volume',
          expr: `sum by (${ah.browserLabel}) (increase(${ah.pageLoads}{${svcFilter}, ${ah.browserLabel}!=""}[$__range]))`,
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
      ],
    });
    children.push(
      new SceneFlexItem({
        minHeight: 250,
        body: PanelBuilders.piechart()
          .setTitle('Browser Volume')
          .setDescription('Measurement volume per browser (from Mimir)')
          .setData(browserVolumeQ)
          .build(),
      })
    );
  }

  return new SceneFlexLayout({
    direction: 'row',
    children,
  });
}

// ---------------------------------------------------------------------------
// Section 5: Support Row (Console Errors + optional Rating Pie)
// ---------------------------------------------------------------------------

/** Build support row with console errors and optional Loki rating pie. */
export function buildSupportSection(ctx: FrontendSceneContext): SceneFlexLayout | null {
  if (!ctx.showLokiPanels) {
    return null;
  }

  const { logsDs, service, isHistogram } = ctx;

  const consoleErrorsQ = makeLokiQuery(logsDs, lokiConsoleErrorsExpr(service, '[$__range]'), '{{value}}', {
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

  if (isHistogram) {
    // Histogram source already shows CWV rating breakdown above — just console errors
    return new SceneFlexLayout({
      direction: 'row',
      children: [consoleErrorsPanel],
    });
  }

  // Loki source: add rating pie alongside console errors
  const fl = otel.faroLoki;
  const ratingStream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"}`;
  const ratingQ = makeLokiQuery(
    logsDs,
    `sum by (${fl.rating}) (count_over_time(${ratingStream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" | ${fl.rating}!="" ${BROWSER_FILTER} | keep ${fl.rating} [$__range]))`,
    `{{${fl.rating}}}`,
    { instant: true }
  );
  const ratingData = new SceneDataTransformer({
    $data: ratingQ,
    transformations: [
      { id: 'reduce', options: { reducers: ['sum'] } },
      { id: 'organize', options: { excludeByName: { Field: true }, renameByName: { Sum: '' } } },
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

  return new SceneFlexLayout({
    direction: 'row',
    children: [ratingPanel, consoleErrorsPanel],
  });
}

// ---------------------------------------------------------------------------
// Section 6: Traffic Row (Measurements + Exceptions + Sessions timeseries)
// ---------------------------------------------------------------------------

/** Build traffic trends timeseries row. */
export function buildTrafficSection(ctx: FrontendSceneContext): SceneFlexLayout {
  const { metricsDs, logsDs, service, svcFilter, ah, isHistogram, showLokiPanels } = ctx;

  let measurementCountQ: SceneQueryRunner;
  let exceptionCountQ: SceneQueryRunner;

  if (isHistogram) {
    measurementCountQ = makePromQuery(
      metricsDs,
      `sum(rate(${ah.pageLoads}{${svcFilter}}[$__rate_interval]))`,
      'Page Loads/s'
    );
    exceptionCountQ = makePromQuery(
      metricsDs,
      `sum(rate(${ah.errors}{${svcFilter}}[$__rate_interval]))`,
      'JS Errors/s'
    );
  } else {
    measurementCountQ = makeLokiQuery(logsDs, lokiMeasurementCountExpr(service, '[$__auto]'), 'Measurements');
    exceptionCountQ = makeLokiQuery(logsDs, lokiExceptionExpr(service, '[$__auto]'), 'JS Exceptions');
  }

  const children: SceneFlexItem[] = [
    new SceneFlexItem({
      minHeight: 200,
      body: PanelBuilders.timeseries()
        .setTitle('Web Vitals Measurements')
        .setDescription('Number of Faro measurement reports over time')
        .setData(measurementCountQ)
        .setUnit('short')
        .setCustomFieldConfig('fillOpacity', 15)
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
  ];

  // Sessions panel (always Loki)
  if (showLokiPanels) {
    const sessionQ = makeLokiQuery(logsDs, lokiSessionStartExpr(service, '[$__auto]'), 'Sessions');
    children.push(
      new SceneFlexItem({
        minHeight: 200,
        body: PanelBuilders.timeseries()
          .setTitle('Sessions')
          .setDescription('New session starts over time')
          .setData(sessionQ)
          .setUnit('short')
          .setCustomFieldConfig('fillOpacity', 25)
          .setColor({ mode: 'fixed', fixedColor: 'blue' } as any)
          .build(),
      })
    );
  }

  return new SceneFlexLayout({
    direction: 'row',
    children,
  });
}
