/**
 * Section builders for the Frontend dashboard.
 *
 * All core metrics come from Mimir (alloy-histogram pipeline).
 * Loki provides enrichment panels (per-page, full error messages, console logs,
 * sessions) when available. Each function builds one logical section (row).
 */
import { SceneFlexLayout, SceneFlexItem, SceneQueryRunner, SceneDataTransformer, PanelBuilders } from '@grafana/scenes';
import { ThresholdsMode, GraphThresholdsStyleMode } from '@grafana/schema';

import { otel } from '../../../otelconfig';
import { sanitizeLabelValue } from '../../../utils/sanitize';
import { PLUGIN_BASE_URL } from '../../../constants';
import { VITAL_THRESHOLDS, CWV_BUCKET_BOUNDARIES, type VitalKey } from './constants';
import { makePromQuery, makeLokiQuery } from './panel-helpers';
import {
  lokiVitalByGroupExpr,
  lokiVitalByPageExpr,
  lokiTopExceptionsExpr,
  lokiExceptionSessionsExpr,
  lokiSessionStartExpr,
  lokiConsoleErrorsExpr,
} from './queries/loki-builders';
import { FrontendSceneContext } from './scene-context';

// ---------------------------------------------------------------------------
// Section 1: CWV Rating Breakdown + Navigation Type
// ---------------------------------------------------------------------------

/** CWV Rating Breakdown (% Good per vital from histogram buckets) + Navigation Type. */
export function buildInsightsSection(ctx: FrontendSceneContext): SceneFlexLayout {
  const { metricsDs, svcFilter, ah } = ctx;

  // CWV Rating Breakdown — show % Good for each vital using histogram bucket math.
  // good_ratio = bucket(good_threshold) / bucket(+Inf)
  const vitals: Array<{ key: VitalKey; label: string }> = [
    { key: 'lcp', label: 'LCP' },
    { key: 'fcp', label: 'FCP' },
    { key: 'cls', label: 'CLS' },
    { key: 'inp', label: 'INP' },
    { key: 'ttfb', label: 'TTFB' },
  ];
  const ratingQueries = vitals.map(({ key, label }) => {
    const metric = ah[key];
    const { good } = CWV_BUCKET_BOUNDARIES[key];
    return {
      refId: label,
      expr: `sum(increase(${metric}_bucket{${svcFilter}, le="${good}"}[$__range])) / sum(increase(${metric}_bucket{${svcFilter}, le="+Inf"}[$__range])) * 100`,
      legendFormat: label,
      instant: true,
    };
  });
  const cwvRatingQ = new SceneQueryRunner({
    datasource: { uid: metricsDs.uid, type: 'prometheus' },
    queries: ratingQueries,
  });
  const cwvRatingPanel = new SceneFlexItem({
    minHeight: 200,
    width: '15%',
    body: PanelBuilders.stat()
      .setTitle('CWV Rating')
      .setDescription('How many page loads are rated "Good" by Google. Higher is better — aim for 75%+.')
      .setData(cwvRatingQ)
      .setUnit('percent')
      .setDecimals(0)
      .setThresholds({
        mode: ThresholdsMode.Absolute,
        steps: [
          { value: 0, color: 'red' },
          { value: 50, color: 'orange' },
          { value: 75, color: 'green' },
        ],
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
      .setDescription('How users arrived: direct navigation, reload, or back/forward button')
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

  // Total pageloads — count FCP histogram samples as proxy (FCP fires on nearly every page load)
  const pageloadsQ = makePromQuery(
    metricsDs,
    `sum(increase(${ah.fcp}_bucket{${svcFilter}, le="+Inf"}[$__range]))`,
    'Pageloads'
  );
  const pageloadsPanel = new SceneFlexItem({
    minHeight: 200,
    width: '15%',
    body: PanelBuilders.stat()
      .setTitle('Pageloads')
      .setDescription('Number of pages loaded by real users')
      .setData(pageloadsQ)
      .setUnit('short')
      .setDecimals(0)
      .build(),
  });

  // Sessions (Loki event count — only when Loki available)
  let sessionsPanel: SceneFlexItem | undefined;
  if (ctx.hasLoki) {
    const sessionsQ = new SceneQueryRunner({
      datasource: { uid: ctx.logsDs.uid, type: 'loki' },
      queries: [
        {
          refId: 'sessions',
          expr: lokiSessionStartExpr(ctx.service, '[$__range]'),
          legendFormat: 'Sessions',
          instant: true,
        },
      ],
    });
    sessionsPanel = new SceneFlexItem({
      minHeight: 200,
      width: '15%',
      body: PanelBuilders.stat()
        .setTitle('Sessions')
        .setDescription('Number of unique browser sessions (a session ends after 30 min of inactivity)')
        .setData(sessionsQ)
        .setUnit('short')
        .setDecimals(0)
        .build(),
    });
  }

  const children = [cwvRatingPanel, pageloadsPanel];
  if (sessionsPanel) {
    children.push(sessionsPanel);
  }
  children.push(navTypePanel);

  return new SceneFlexLayout({
    direction: 'row',
    children,
  });
}

// ---------------------------------------------------------------------------
// Section 2: Web Vitals Trends (p75 timeseries from Mimir histograms)
// ---------------------------------------------------------------------------

/** Web Vitals p75 trends: TTFB → FCP → LCP + INP + CLS. */
export function buildTrendsSection(ctx: FrontendSceneContext): SceneFlexLayout {
  const { metricsDs, svcFilter, ah } = ctx;

  const pageLoadVitalsQ = new SceneQueryRunner({
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
  const inpTrendQ = makePromQuery(
    metricsDs,
    `histogram_quantile(0.75, sum(rate(${ah.inp}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
    'INP'
  );
  const clsTrendQ = makePromQuery(
    metricsDs,
    `histogram_quantile(0.75, sum(rate(${ah.cls}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
    'CLS'
  );

  return new SceneFlexLayout({
    direction: 'row',
    children: [
      new SceneFlexItem({
        minHeight: 200,
        body: PanelBuilders.timeseries()
          .setTitle('Page Load Vitals (p75)')
          .setDescription('How fast pages load: Time to First Byte → First Contentful Paint → Largest Contentful Paint')
          .setData(pageLoadVitalsQ)
          .setUnit('ms')
          .build(),
      }),
      new SceneFlexItem({
        minHeight: 200,
        body: PanelBuilders.timeseries()
          .setTitle('Interactivity (INP p75)')
          .setDescription('How fast the page responds to user clicks and key presses')
          .setData(inpTrendQ)
          .setUnit('ms')
          .setCustomFieldConfig('thresholdsStyle', { mode: GraphThresholdsStyleMode.Area })
          .setThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS.inp })
          .build(),
      }),
      new SceneFlexItem({
        minHeight: 200,
        body: PanelBuilders.timeseries()
          .setTitle('Layout Stability (CLS p75)')
          .setDescription('How much the page layout shifts unexpectedly while loading (lower is better)')
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
// Section 3: Per-Page Performance Table (Loki enrichment)
// ---------------------------------------------------------------------------

/** Per-page performance table — requires Loki for page_url breakdown. */
export function buildPerPageSection(ctx: FrontendSceneContext): SceneFlexItem | null {
  if (!ctx.hasLoki) {
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
        expr: `topk(20, sum by (${pageUrl}) (count_over_time(${countPipeline} [$__range])))`,
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
      {
        id: 'organize',
        options: {
          excludeByName: { Time: true },
        },
      },
      { id: 'sortBy', options: { sort: [{ field: 'Value #count', desc: true }] } },
      { id: 'limit', options: { maxRows: 20 } },
    ],
  });

  return new SceneFlexItem({
    minHeight: 300,
    body: PanelBuilders.table()
      .setTitle('Per-Page Performance')
      .setDescription('Performance per page — sorted by most visited. Color shows Good/Needs Work/Poor.')
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
      })
      .build(),
  });
}

// ---------------------------------------------------------------------------
// Section 4: Errors Row (Exception Types + Top Exceptions + Browser)
// ---------------------------------------------------------------------------

/** Errors section — split into two rows: exceptions row + browser row. */
export function buildErrorsSection(ctx: FrontendSceneContext): SceneFlexLayout {
  const { logsDs, metricsDs, service, namespace, environment, svcFilter, ah, hasLoki } = ctx;
  const fl = otel.faroLoki;

  // --- Exceptions row (always has at least the Mimir types panel) ---
  const exceptionsChildren: SceneFlexItem[] = [];

  // Exception Types from Mimir counter (fast PromQL)
  const exceptionTypeQ = new SceneQueryRunner({
    datasource: { uid: metricsDs.uid, type: 'prometheus' },
    queries: [
      {
        refId: 'types',
        expr: `topk(10, sum by (${ah.exceptionTypeLabel}) (increase(${ah.errors}{${svcFilter}, ${ah.exceptionTypeLabel}!=""}[$__range])))`,
        legendFormat: `{{${ah.exceptionTypeLabel}}}`,
        format: 'table',
        instant: true,
      },
    ],
  });
  exceptionsChildren.push(
    new SceneFlexItem({
      minHeight: 250,
      width: '30%',
      body: PanelBuilders.table()
        .setTitle('Exception Types')
        .setDescription('Which error types occur most often')
        .setData(exceptionTypeQ)
        .setOverrides((b) => {
          b.matchFieldsWithName(ah.exceptionTypeLabel).overrideDisplayName('Exception Type');
          b.matchFieldsWithName('Value').overrideDisplayName('Count').overrideDecimals(0);
          b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
        })
        .build(),
    })
  );

  // Top Exceptions with full messages and session count (Loki enrichment)
  if (hasLoki) {
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
    exceptionsChildren.push(
      new SceneFlexItem({
        minHeight: 250,
        body: PanelBuilders.table()
          .setTitle('Top Exceptions')
          .setDescription('Most common JavaScript errors — click an error to see full details in the Logs tab')
          .setData(topExceptionsData)
          .setOverrides((b) => {
            b.matchFieldsWithName('value')
              .overrideDisplayName('Error')
              .overrideCustomFieldConfig('width' as any, 500);
            b.matchFieldsWithName('Value #count')
              .overrideDisplayName('Occurrences')
              .overrideCustomFieldConfig('width' as any, 110);
            b.matchFieldsWithName('Value #sessions')
              .overrideDisplayName('Sessions Affected')
              .overrideCustomFieldConfig('width' as any, 130);
            b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
            const envParam = environment ? `&environment=${encodeURIComponent(environment)}` : '';
            const nsSegment = encodeURIComponent(namespace || '_');
            b.matchFieldsWithName('value').overrideLinks([
              {
                title: 'View in Logs',
                url: `${PLUGIN_BASE_URL}/services/${nsSegment}/${encodeURIComponent(service)}?tab=logs&from=\${__from}&to=\${__to}${envParam}&includeFaro=true&kindFilter=exception`,
                targetBlank: false,
              } as any,
            ]);
          })
          .build(),
      })
    );
  }

  const exceptionsRow = new SceneFlexLayout({ direction: 'row', children: exceptionsChildren });

  // --- Browser row (only when Loki available) ---
  if (!hasLoki) {
    return exceptionsRow;
  }

  const browserChildren: SceneFlexItem[] = [];

  // Browser breakdown (Loki vitals per browser)
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
  browserChildren.push(
    new SceneFlexItem({
      minHeight: 250,
      body: PanelBuilders.table()
        .setTitle('Browser Breakdown')
        .setDescription('Performance comparison across browsers your users are on')
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
    })
  );

  // Browser volume pie (from Loki measurement counts per browser_name)
  const browserVolumePipeline = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" | ${fl.browserName}!=""`;
  const browserVolumeQ = new SceneQueryRunner({
    datasource: { uid: logsDs.uid, type: 'loki' },
    queries: [
      {
        refId: 'volume',
        expr: `sum by (${fl.browserName}) (count_over_time(${browserVolumePipeline} [$__range]))`,
        legendFormat: `{{${fl.browserName}}}`,
      },
    ],
  });
  browserChildren.push(
    new SceneFlexItem({
      minHeight: 250,
      width: '35%',
      body: PanelBuilders.piechart()
        .setTitle('Browser Volume')
        .setDescription('Traffic share per browser')
        .setData(browserVolumeQ)
        .build(),
    })
  );

  const browserRow = new SceneFlexLayout({ direction: 'row', children: browserChildren });

  return new SceneFlexLayout({
    direction: 'column',
    children: [exceptionsRow, browserRow],
  });
}

// ---------------------------------------------------------------------------
// Section 5: Console Errors (Loki enrichment)
// ---------------------------------------------------------------------------

/** Console errors table — requires Loki. */
export function buildSupportSection(ctx: FrontendSceneContext): SceneFlexLayout | null {
  if (!ctx.hasLoki) {
    return null;
  }

  const { logsDs, service } = ctx;

  const consoleErrorsQ = makeLokiQuery(logsDs, lokiConsoleErrorsExpr(service, '[$__range]'), '{{value}}', {
    instant: true,
  });

  return new SceneFlexLayout({
    direction: 'row',
    children: [
      new SceneFlexItem({
        minHeight: 250,
        body: PanelBuilders.table()
          .setTitle('Console Errors')
          .setDescription('Repeated console.error messages from the browser — check if your app logs errors silently')
          .setData(consoleErrorsQ)
          .setOverrides((b) => {
            b.matchFieldsWithName('value').overrideDisplayName('Error Message');
            b.matchFieldsWithName('Value').overrideDisplayName('Count');
            b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
          })
          .build(),
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Section 6: Traffic (Page Loads + Errors + Sessions timeseries)
// ---------------------------------------------------------------------------

/** Traffic timeseries — Mimir rate counters + optional Loki sessions. */
export function buildTrafficSection(ctx: FrontendSceneContext): SceneFlexLayout {
  const { metricsDs, logsDs, service, svcFilter, ah, hasLoki } = ctx;

  const measurementCountQ = makePromQuery(
    metricsDs,
    `sum(rate(${ah.pageLoads}{${svcFilter}}[$__rate_interval]))`,
    'Page Loads/s'
  );
  const exceptionCountQ = makePromQuery(
    metricsDs,
    `sum(rate(${ah.errors}{${svcFilter}}[$__rate_interval]))`,
    'JS Errors/s'
  );

  const children: SceneFlexItem[] = [
    new SceneFlexItem({
      minHeight: 200,
      body: PanelBuilders.timeseries()
        .setTitle('Web Vitals Measurements')
        .setDescription('Page load traffic over time')
        .setData(measurementCountQ)
        .setUnit('short')
        .setCustomFieldConfig('fillOpacity', 15)
        .build(),
    }),
    new SceneFlexItem({
      minHeight: 200,
      body: PanelBuilders.timeseries()
        .setTitle('JavaScript Exceptions')
        .setDescription('How often JavaScript errors occur over time')
        .setData(exceptionCountQ)
        .setUnit('short')
        .setCustomFieldConfig('fillOpacity', 15)
        .build(),
    }),
  ];

  // Sessions (Loki enrichment — session_start events)
  if (hasLoki) {
    const sessionQ = makeLokiQuery(logsDs, lokiSessionStartExpr(service, '[$__auto]'), 'Sessions');
    children.push(
      new SceneFlexItem({
        minHeight: 200,
        body: PanelBuilders.timeseries()
          .setTitle('Sessions')
          .setDescription('New user sessions starting over time')
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
