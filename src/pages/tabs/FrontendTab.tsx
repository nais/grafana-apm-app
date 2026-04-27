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
import { DashboardCursorSync, GraphThresholdsStyleMode, StackingMode, VizOrientation } from '@grafana/schema';
import { getFrontendMetrics } from '../../api/client';
import { usePluginDatasources } from '../../utils/datasources';
import { useTimeRange } from '../../utils/timeRange';
import { sanitizeLabelValue } from '../../utils/sanitize';
import { otel } from '../../otelconfig';
import { PLUGIN_BASE_URL } from '../../constants';

import {
  VITAL_THRESHOLDS,
  BROWSER_FILTER,
  WebVitalsBullets,
  makePromQuery,
  makeLokiQuery,
  normalizePageUrlExpr,
  lokiVitalExpr,
  lokiVitalByGroupExpr,
  lokiVitalByPageExpr,
  lokiExceptionExpr,
  lokiTopExceptionsExpr,
  lokiExceptionSessionsExpr,
  lokiSessionStartExpr,
  lokiConsoleErrorsExpr,
  lokiMeasurementCountExpr,
  histogramFilter,
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
        setVitals(r.vitals);
      })
      .catch(() => {
        if (!cancelled) {
          setAvailable(false);
          setSource(null);
          setVitals(undefined);
        }
      });

    return () => {
      cancelled = true;
      setAvailable(null);
      setSource(null);
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

// ========================================================================
// Unified Frontend Panels — one layout for both histogram (Mimir) and Loki sources.
// The layout matches the established Loki design (bullet charts, per-page table,
// exceptions, rating distribution, browser breakdown, traffic timeseries).
// Data queries switch between Mimir histograms and Loki LogQL based on `source`.
// ========================================================================

function UnifiedFrontendPanels({
  source,
  service,
  namespace,
  environment,
  vitals,
}: {
  source: 'loki' | 'alloy-histogram';
  service: string;
  namespace: string;
  environment?: string;
  vitals?: Record<string, number>;
}) {
  const ds = usePluginDatasources(environment || undefined);
  const { from, to } = useTimeRange();

  const ah = otel.alloyHistogram;
  const isHistogram = source === 'alloy-histogram';

  // Mimir filter for histogram queries
  const svcFilter = isHistogram
    ? histogramFilter(sanitizeLabelValue(service), environment ? sanitizeLabelValue(environment) : undefined)
    : '';

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from, to });
    const lDs = { uid: ds.logsUid };
    const mDs = { uid: ds.metricsUid };

    // --- Section 1: CWV Rating Breakdown + Navigation Type (histogram only) ---
    // CWV Rating: % good / needs-improvement / poor per vital from bucket math
    // Nav Type: 100% stacked timeseries showing navigate/reload/back_forward distribution
    let insightsRow: SceneFlexLayout | null = null;
    if (isHistogram) {
      // CWV Rating Breakdown — stacked bar per vital
      // Uses bucket boundaries aligned with CWV thresholds
      const cwvRatingQ = new SceneQueryRunner({
        datasource: { uid: ds.metricsUid, type: 'prometheus' },
        queries: [
          {
            refId: 'lcp_good',
            expr: `increase(${ah.lcp}_bucket{${svcFilter}, le="2500"}[$__range]) / increase(${ah.lcp}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'LCP Good',
            instant: true,
          },
          {
            refId: 'lcp_ni',
            expr: `(increase(${ah.lcp}_bucket{${svcFilter}, le="4000"}[$__range]) - increase(${ah.lcp}_bucket{${svcFilter}, le="2500"}[$__range])) / increase(${ah.lcp}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'LCP Needs Improvement',
            instant: true,
          },
          {
            refId: 'lcp_poor',
            expr: `1 - increase(${ah.lcp}_bucket{${svcFilter}, le="4000"}[$__range]) / increase(${ah.lcp}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'LCP Poor',
            instant: true,
          },
          {
            refId: 'fcp_good',
            expr: `increase(${ah.fcp}_bucket{${svcFilter}, le="1800"}[$__range]) / increase(${ah.fcp}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'FCP Good',
            instant: true,
          },
          {
            refId: 'fcp_ni',
            expr: `(increase(${ah.fcp}_bucket{${svcFilter}, le="3000"}[$__range]) - increase(${ah.fcp}_bucket{${svcFilter}, le="1800"}[$__range])) / increase(${ah.fcp}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'FCP Needs Improvement',
            instant: true,
          },
          {
            refId: 'fcp_poor',
            expr: `1 - increase(${ah.fcp}_bucket{${svcFilter}, le="3000"}[$__range]) / increase(${ah.fcp}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'FCP Poor',
            instant: true,
          },
          {
            refId: 'cls_good',
            expr: `increase(${ah.cls}_bucket{${svcFilter}, le="0.1"}[$__range]) / increase(${ah.cls}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'CLS Good',
            instant: true,
          },
          {
            refId: 'cls_ni',
            expr: `(increase(${ah.cls}_bucket{${svcFilter}, le="0.25"}[$__range]) - increase(${ah.cls}_bucket{${svcFilter}, le="0.1"}[$__range])) / increase(${ah.cls}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'CLS Needs Improvement',
            instant: true,
          },
          {
            refId: 'cls_poor',
            expr: `1 - increase(${ah.cls}_bucket{${svcFilter}, le="0.25"}[$__range]) / increase(${ah.cls}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'CLS Poor',
            instant: true,
          },
          {
            refId: 'inp_good',
            expr: `increase(${ah.inp}_bucket{${svcFilter}, le="200"}[$__range]) / increase(${ah.inp}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'INP Good',
            instant: true,
          },
          {
            refId: 'inp_ni',
            expr: `(increase(${ah.inp}_bucket{${svcFilter}, le="500"}[$__range]) - increase(${ah.inp}_bucket{${svcFilter}, le="200"}[$__range])) / increase(${ah.inp}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'INP Needs Improvement',
            instant: true,
          },
          {
            refId: 'inp_poor',
            expr: `1 - increase(${ah.inp}_bucket{${svcFilter}, le="500"}[$__range]) / increase(${ah.inp}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'INP Poor',
            instant: true,
          },
          {
            refId: 'ttfb_good',
            expr: `increase(${ah.ttfb}_bucket{${svcFilter}, le="800"}[$__range]) / increase(${ah.ttfb}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'TTFB Good',
            instant: true,
          },
          {
            refId: 'ttfb_ni',
            expr: `(increase(${ah.ttfb}_bucket{${svcFilter}, le="2000"}[$__range]) - increase(${ah.ttfb}_bucket{${svcFilter}, le="800"}[$__range])) / increase(${ah.ttfb}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'TTFB Needs Improvement',
            instant: true,
          },
          {
            refId: 'ttfb_poor',
            expr: `1 - increase(${ah.ttfb}_bucket{${svcFilter}, le="2000"}[$__range]) / increase(${ah.ttfb}_bucket{${svcFilter}, le="+Inf"}[$__range])`,
            legendFormat: 'TTFB Poor',
            instant: true,
          },
        ],
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
            b.matchFieldsByQuery('lcp_good').overrideColor({ mode: 'fixed', fixedColor: 'green' });
            b.matchFieldsByQuery('lcp_ni').overrideColor({ mode: 'fixed', fixedColor: 'orange' });
            b.matchFieldsByQuery('lcp_poor').overrideColor({ mode: 'fixed', fixedColor: 'red' });
            b.matchFieldsByQuery('fcp_good').overrideColor({ mode: 'fixed', fixedColor: 'green' });
            b.matchFieldsByQuery('fcp_ni').overrideColor({ mode: 'fixed', fixedColor: 'orange' });
            b.matchFieldsByQuery('fcp_poor').overrideColor({ mode: 'fixed', fixedColor: 'red' });
            b.matchFieldsByQuery('cls_good').overrideColor({ mode: 'fixed', fixedColor: 'green' });
            b.matchFieldsByQuery('cls_ni').overrideColor({ mode: 'fixed', fixedColor: 'orange' });
            b.matchFieldsByQuery('cls_poor').overrideColor({ mode: 'fixed', fixedColor: 'red' });
            b.matchFieldsByQuery('inp_good').overrideColor({ mode: 'fixed', fixedColor: 'green' });
            b.matchFieldsByQuery('inp_ni').overrideColor({ mode: 'fixed', fixedColor: 'orange' });
            b.matchFieldsByQuery('inp_poor').overrideColor({ mode: 'fixed', fixedColor: 'red' });
            b.matchFieldsByQuery('ttfb_good').overrideColor({ mode: 'fixed', fixedColor: 'green' });
            b.matchFieldsByQuery('ttfb_ni').overrideColor({ mode: 'fixed', fixedColor: 'orange' });
            b.matchFieldsByQuery('ttfb_poor').overrideColor({ mode: 'fixed', fixedColor: 'red' });
          })
          .build(),
      });

      // Navigation Type — 100% stacked timeseries
      const navTypeQ = makePromQuery(
        mDs,
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

      insightsRow = new SceneFlexLayout({
        direction: 'row',
        children: [cwvRatingPanel, navTypePanel],
      });
    }

    // --- Section 2: Web Vitals time series trends ---
    let pageLoadVitalsQ: SceneQueryRunner;
    let inpTrendQ: SceneQueryRunner;
    let clsTrendQ: SceneQueryRunner;

    if (isHistogram) {
      pageLoadVitalsQ = new SceneQueryRunner({
        datasource: { uid: ds.metricsUid, type: 'prometheus' },
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
        mDs,
        `histogram_quantile(0.75, sum(rate(${ah.inp}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
        'INP'
      );
      clsTrendQ = makePromQuery(
        mDs,
        `histogram_quantile(0.75, sum(rate(${ah.cls}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
        'CLS'
      );
    } else {
      pageLoadVitalsQ = new SceneQueryRunner({
        datasource: { uid: ds.logsUid, type: 'loki' },
        queries: [
          { refId: 'A', expr: lokiVitalExpr(service, otel.faroLoki.ttfb, '[$__auto]'), legendFormat: 'TTFB' },
          { refId: 'B', expr: lokiVitalExpr(service, otel.faroLoki.fcp, '[$__auto]'), legendFormat: 'FCP' },
          { refId: 'C', expr: lokiVitalExpr(service, otel.faroLoki.lcp, '[$__auto]'), legendFormat: 'LCP' },
        ],
      });
      inpTrendQ = makeLokiQuery(lDs, lokiVitalExpr(service, otel.faroLoki.inp, '[$__auto]'), 'INP');
      clsTrendQ = makeLokiQuery(lDs, lokiVitalExpr(service, otel.faroLoki.cls, '[$__auto]'), 'CLS');
    }

    const trendTitle = isHistogram ? 'p75' : 'avg';
    const trendsRow = new SceneFlexLayout({
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

    // --- Row 4: Per-Page Performance Table (always Loki — needs page_url from logs) ---
    const pageUrl = otel.faroLoki.pageUrl;
    const countPipeline = `{${otel.faroLoki.serviceName}="${sanitizeLabelValue(service)}", ${otel.faroLoki.kind}="${otel.faroLoki.kindMeasurement}"} | logfmt | ${otel.faroLoki.typeField}="${otel.faroLoki.typeWebVitals}" | ${pageUrl}!="" | keep ${pageUrl}`;
    const perPageQ = new SceneQueryRunner({
      datasource: { uid: ds.logsUid, type: 'loki' },
      queries: [
        {
          refId: 'lcp',
          expr: lokiVitalByPageExpr(service, otel.faroLoki.lcp, pageUrl, '[$__range]'),
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'fcp',
          expr: lokiVitalByPageExpr(service, otel.faroLoki.fcp, pageUrl, '[$__range]'),
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'cls',
          expr: lokiVitalByPageExpr(service, otel.faroLoki.cls, pageUrl, '[$__range]'),
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'inp',
          expr: lokiVitalByPageExpr(service, otel.faroLoki.inp, pageUrl, '[$__range]'),
          legendFormat: '__auto',
          format: 'table',
          instant: true,
        },
        {
          refId: 'ttfb',
          expr: lokiVitalByPageExpr(service, otel.faroLoki.ttfb, pageUrl, '[$__range]'),
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
      transformations: [{ id: 'merge', options: {} }],
    });

    const perPageTable = new SceneFlexItem({
      minHeight: 250,
      body: PanelBuilders.table()
        .setTitle('Per-Page Performance')
        .setDescription('Average Web Vitals per page route (UUIDs and numeric IDs collapsed)')
        .setData(perPageData)
        .setOption('sortBy', [{ displayName: 'Measurements', desc: true }])
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
          b.matchFieldsWithName('Value #count').overrideDisplayName('Measurements').overrideDecimals(0);
          b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
        })
        .build(),
    });

    // --- Row 5: Top Exceptions + Console Errors (always Loki) ---
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

    // Browser breakdown table — Loki for per-browser vitals, Mimir for volume (histogram source)
    const browserQueries: Array<{
      refId: string;
      expr: string;
      legendFormat: string;
      format: string;
      instant: boolean;
    }> = [
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
    ];
    const browserQ = new SceneQueryRunner({
      datasource: { uid: ds.logsUid, type: 'loki' },
      queries: browserQueries,
    });

    // When histogram source, add a separate Mimir query for browser volume
    let browserVolumeQ: SceneQueryRunner | null = null;
    if (isHistogram) {
      browserVolumeQ = new SceneQueryRunner({
        datasource: { uid: ds.metricsUid, type: 'prometheus' },
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
    }

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

    // Mimir browser volume panel (shown alongside browser table when histogram source)
    const browserVolumePanel = browserVolumeQ
      ? new SceneFlexItem({
          minHeight: 250,
          body: PanelBuilders.piechart()
            .setTitle('Browser Volume')
            .setDescription('Measurement volume per browser (from Mimir)')
            .setData(browserVolumeQ)
            .build(),
        })
      : null;

    const errorsRow = new SceneFlexLayout({
      direction: 'row',
      children: [topExceptionsPanel, browserTable, ...(browserVolumePanel ? [browserVolumePanel] : [])],
    });

    // --- Section 4: Support row ---
    // For histogram source: CWV rating is already shown via bucket breakdown above,
    // so only show console errors (full width).
    // For Loki source: keep Loki-based rating pie alongside console errors.
    let supportRow: SceneFlexLayout;
    if (isHistogram) {
      supportRow = new SceneFlexLayout({
        direction: 'row',
        children: [consoleErrorsPanel],
      });
    } else {
      const fl = otel.faroLoki;
      const ratingStream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"}`;
      const ratingQ = makeLokiQuery(
        lDs,
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
      supportRow = new SceneFlexLayout({
        direction: 'row',
        children: [ratingPanel, consoleErrorsPanel],
      });
    }

    // --- Row 7: Traffic trends over time ---
    let measurementCountQ: SceneQueryRunner;
    let exceptionCountQ: SceneQueryRunner;

    if (isHistogram) {
      measurementCountQ = makePromQuery(
        mDs,
        `sum(rate(${ah.pageLoads}{${svcFilter}}[$__rate_interval]))`,
        'Page Loads/s'
      );
      exceptionCountQ = makePromQuery(mDs, `sum(rate(${ah.errors}{${svcFilter}}[$__rate_interval]))`, 'JS Errors/s');
    } else {
      measurementCountQ = makeLokiQuery(lDs, lokiMeasurementCountExpr(service, '[$__auto]'), 'Measurements');
      exceptionCountQ = makeLokiQuery(lDs, lokiExceptionExpr(service, '[$__auto]'), 'JS Exceptions');
    }
    const sessionQ = makeLokiQuery(lDs, lokiSessionStartExpr(service, '[$__auto]'), 'Sessions');

    const trafficRow = new SceneFlexLayout({
      direction: 'row',
      children: [
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
        }),
      ],
    });

    // --- Filter variables ---
    const browserVar = new CustomVariable({
      name: 'browser',
      label: 'Browser',
      isMulti: false,
      includeAll: true,
      allValue: '.*',
      query: 'Chrome,Firefox,Safari,Edge,Opera,Samsung Internet',
      value: '$__all',
    });

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
          errorsRow,
          perPageTable,
          trafficRow,
          supportRow,
        ],
      }),
    });
  }, [from, to, ds, service, namespace, svcFilter, ah, isHistogram, vitals]);

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
