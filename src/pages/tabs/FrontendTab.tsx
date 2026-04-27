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
import { buildExploreUrl } from '../../utils/explore';
import { BulletGraph, BulletGraphThreshold } from '../../components/BulletGraph';

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
  const [hasLoki, setHasLoki] = useState(false);

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
        setHasLoki(r.hasLoki ?? false);
      })
      .catch(() => {
        if (!cancelled) {
          setAvailable(false);
          setSource(null);
          setVitals(undefined);
          setHasLoki(false);
        }
      });

    return () => {
      cancelled = true;
      setAvailable(null);
      setSource(null);
      setVitals(undefined);
      setHasLoki(false);
    };
  }, [service, namespace, environment]);

  if (available === null) {
    return <LoadingPlaceholder text="Checking for browser telemetry..." />;
  }

  if (!available || !source) {
    return <SetupPlaceholder namespace={namespace} service={service} />;
  }

  // Only show bullet graphs when all core vitals are present to avoid partial display
  const REQUIRED_VITALS = ['lcp', 'fcp', 'cls', 'inp', 'ttfb'];
  const hasAllVitals = vitals != null && REQUIRED_VITALS.every((k) => k in vitals);

  return (
    <div className={styles.container}>
      {source === 'loki' && (
        <LokiWebVitalsPanels
          service={service}
          environment={environment}
          showVitalsRow={!hasAllVitals}
          vitals={hasAllVitals ? vitals : undefined}
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
      {source === 'alloy-histogram' && (
        <HistogramWebVitalsPanels
          service={service}
          environment={environment}
          showVitalsRow={!hasAllVitals}
          vitals={hasAllVitals ? vitals : undefined}
          hasLoki={hasLoki}
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

// ---- Web Vitals bullet graph summary ----

interface VitalDef {
  key: string;
  label: string;
  description: string;
  tooltip: string;
  unit?: string;
  decimals?: number;
  thresholds: BulletGraphThreshold[];
}

const VITAL_DEFS: VitalDef[] = [
  {
    key: 'ttfb',
    label: 'TTFB',
    description: 'Time to First Byte',
    tooltip: 'Time from request start until the first byte of the response is received. Target < 800 ms.',
    unit: 'ms',
    thresholds: VITAL_THRESHOLDS.ttfb,
  },
  {
    key: 'fcp',
    label: 'FCP',
    description: 'First Contentful Paint',
    tooltip: 'Time until the first text or image is painted. Target < 1800 ms.',
    unit: 'ms',
    thresholds: VITAL_THRESHOLDS.fcp,
  },
  {
    key: 'lcp',
    label: 'LCP',
    description: 'Largest Contentful Paint',
    tooltip: 'Time until the largest text or image element is rendered. Target < 2500 ms.',
    unit: 'ms',
    thresholds: VITAL_THRESHOLDS.lcp,
  },
  {
    key: 'cls',
    label: 'CLS',
    description: 'Cumulative Layout Shift',
    tooltip: 'Total of all unexpected layout shift scores. Target < 0.1.',
    decimals: 2,
    thresholds: VITAL_THRESHOLDS.cls,
  },
  {
    key: 'inp',
    label: 'INP',
    description: 'Interaction to Next Paint',
    tooltip: 'Latency of the slowest interaction during the page visit. Target < 200 ms.',
    unit: 'ms',
    thresholds: VITAL_THRESHOLDS.inp,
  },
];

function WebVitalsBullets({ vitals }: { vitals: Record<string, number> }) {
  const styles = useStyles2(getBulletStyles);

  return (
    <div className={styles.grid}>
      {VITAL_DEFS.map((def) => (
        <BulletGraph
          key={def.key}
          value={vitals[def.key] ?? null}
          thresholds={def.thresholds}
          label={def.label}
          description={def.description}
          tooltip={def.tooltip}
          unit={def.unit}
          decimals={def.decimals}
        />
      ))}
    </div>
  );
}

const getBulletStyles = (theme: GrafanaTheme2) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: ${theme.spacing(1)};
  `,
});

// ---- LogQL helper for Faro vital queries ----

// Browser filter — Scenes interpolates $browser at query time.
// When "All" is selected, allValue is '.*' so the regex matches everything.
// The trailing `|` also matches empty string, so services using older Faro SDKs
// that don't populate browser_name still return data.
const BROWSER_FILTER = `| browser_name=~"$browser|"`;

function lokiVitalPipeline(service: string, vital: string, extraKeep?: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"}`;
  const keepFields = extraKeep ? `${vital}, ${extraKeep}` : vital;
  return `${stream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" | ${vital}!="" ${BROWSER_FILTER} | keep ${keepFields}`;
}

// Weighted mean: sum(values) / count(lines) across all streams.
function lokiVitalExpr(service: string, vital: string, window: string): string {
  const pipeline = lokiVitalPipeline(service, vital);
  return `sum(sum_over_time(${pipeline} | unwrap ${vital} ${window})) / sum(count_over_time(${pipeline} ${window}))`;
}

function lokiVitalByGroupExpr(service: string, vital: string, groupBy: string, window: string): string {
  const pipeline = lokiVitalPipeline(service, vital, groupBy);
  return `sum by (${groupBy}) (sum_over_time(${pipeline} | unwrap ${vital} ${window})) / sum by (${groupBy}) (count_over_time(${pipeline} ${window}))`;
}

// URL normalization: collapse UUIDs and long numeric IDs into wildcards, strip query params.
// Applied via label_replace + re-aggregation so multiple raw URLs map to one route pattern.
function normalizePageUrlExpr(innerExpr: string, label: string): string {
  return `sum by (${label}) (
    label_replace(
      label_replace(
        label_replace(
          ${innerExpr},
          "${label}", "$1", "${label}", "([^?]*)\\\\?.*"
        ),
        "${label}", "\${1}*\${2}", "${label}", "(.*?)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(.*)"
      ),
      "${label}", "\${1}*\${2}", "${label}", "(.*?)/[0-9]{5,}(.*)"
    )
  )`;
}

function lokiVitalByPageExpr(service: string, vital: string, pageLabel: string, window: string): string {
  const pipeline = lokiVitalPipeline(service, vital, pageLabel);
  const sumExpr = `sum by (${pageLabel}) (sum_over_time(${pipeline} | unwrap ${vital} ${window}))`;
  const countExpr = `sum by (${pageLabel}) (count_over_time(${pipeline} ${window}))`;
  return `${normalizePageUrlExpr(sumExpr, pageLabel)} / ${normalizePageUrlExpr(countExpr, pageLabel)}`;
}

function lokiExceptionExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"}`;
  return `sum(count_over_time(${stream} | logfmt ${BROWSER_FILTER} ${window}))`;
}

function lokiTopExceptionsExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"}`;
  return `topk(20, sum by (value) (count_over_time(${stream} | logfmt | value!="" ${BROWSER_FILTER} | keep value ${window})))`;
}

function lokiExceptionSessionsExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"}`;
  return `topk(20, count by (value) (sum by (value, session_id) (count_over_time(${stream} | logfmt | value!="" | session_id!="" ${BROWSER_FILTER} | keep value, session_id ${window}))))`;
}

function lokiSessionStartExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindEvent}"}`;
  return `sum(count_over_time(${stream} | logfmt | event_name="session_start" ${BROWSER_FILTER} ${window}))`;
}

function lokiConsoleErrorsExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindLog}"}`;
  return `topk(10, sum by (value) (count_over_time(${stream} | logfmt | level="error" | value!="" ${BROWSER_FILTER} | keep value ${window})))`;
}

function lokiMeasurementCountExpr(service: string, window: string): string {
  const fl = otel.faroLoki;
  const stream = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindMeasurement}"}`;
  return `sum(count_over_time(${stream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" ${BROWSER_FILTER} ${window}))`;
}

// ========================================================================
// Loki-based Web Vitals panels (Faro data in Loki)
// ========================================================================

function LokiWebVitalsPanels({
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

    // --- Row 2: Overview stats (page views, sessions, errors) ---
    const pageViewsQ = makeLokiQuery(lDs, lokiMeasurementCountExpr(service, '[$__range]'), 'Page Views', {
      instant: true,
    });
    const sessionsStatQ = makeLokiQuery(lDs, lokiSessionStartExpr(service, '[$__range]'), 'Sessions', {
      instant: true,
    });
    const errorsStatQ = makeLokiQuery(lDs, lokiExceptionExpr(service, '[$__range]'), 'Errors', { instant: true });

    const overviewRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({
          minHeight: 100,
          body: PanelBuilders.stat()
            .setTitle('Page Views')
            .setDescription('Total Web Vitals measurements in time range')
            .setData(pageViewsQ)
            .setUnit('short')
            .setColor({ mode: 'fixed', fixedColor: 'blue' } as any)
            .build(),
        }),
        new SceneFlexItem({
          minHeight: 100,
          body: PanelBuilders.stat()
            .setTitle('Sessions')
            .setDescription('Unique user sessions started in time range')
            .setData(sessionsStatQ)
            .setUnit('short')
            .setColor({ mode: 'fixed', fixedColor: 'purple' } as any)
            .build(),
        }),
        new SceneFlexItem({
          minHeight: 100,
          body: PanelBuilders.stat()
            .setTitle('JS Errors')
            .setDescription('Total JavaScript exceptions in time range')
            .setData(errorsStatQ)
            .setUnit('short')
            .setColor({ mode: 'fixed', fixedColor: 'red' } as any)
            .build(),
        }),
      ],
    });

    // --- Row 3: Web Vitals time series trends (use $__auto for trend resolution) ---
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

    // --- Row 4: Per-Page Performance Table ---
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
      `sum by (${fl.rating}) (count_over_time(${ratingStream} | logfmt | ${fl.typeField}="${fl.typeWebVitals}" | ${fl.rating}!="" ${BROWSER_FILTER} | keep ${fl.rating} [$__range]))`,
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
            renameByName: { Sum: '' },
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
          b.matchFieldsWithName('value').overrideLinks([
            {
              title: 'Explore in Loki',
              url: buildExploreUrl({
                datasourceUid: ds.logsUid,
                queries: [
                  {
                    refId: 'A',
                    expr: `{${otel.faroLoki.serviceName}="${sanitizeLabelValue(service)}", ${otel.faroLoki.kind}="${otel.faroLoki.kindException}"} | logfmt | value=\`\${__data.fields.value}\``,
                  },
                ],
                range: { from: '${__from:date:iso}', to: '${__to:date:iso}' },
              }),
              targetBlank: true,
            } as any,
          ]);
        })
        .build(),
    });

    // --- Console Errors table ---
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

    // --- Errors section: Top Exceptions + Console Errors side by side ---
    const errorsRow = new SceneFlexLayout({
      direction: 'row',
      children: [topExceptionsPanel, consoleErrorsPanel],
    });

    // --- Support section: Rating + Browser ---
    const supportRow = new SceneFlexLayout({
      direction: 'row',
      children: [ratingPanel, browserTable],
    });

    // --- Traffic trends: Measurements + Exceptions + Sessions over time ---
    const measurementCountQ = makeLokiQuery(lDs, lokiMeasurementCountExpr(service, '[$__auto]'), 'Measurements');
    const exceptionCountQ = makeLokiQuery(lDs, lokiExceptionExpr(service, '[$__auto]'), 'JS Exceptions');
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
          ...(showVitalsRow ? [vitalsRow] : []),
          overviewRow,
          perPageTable,
          trendsRow,
          errorsRow,
          supportRow,
          trafficRow,
        ],
      }),
    });
  }, [from, to, ds, service, showVitalsRow, vitals]);

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
// Alloy Histogram panels — hybrid view using histograms + optional Loki enrichment
// ========================================================================

function HistogramWebVitalsPanels({
  service,
  environment,
  showVitalsRow = true,
  vitals,
  hasLoki,
}: {
  service: string;
  environment?: string;
  showVitalsRow?: boolean;
  vitals?: Record<string, number>;
  hasLoki: boolean;
}) {
  const ds = usePluginDatasources(environment || undefined);
  const { from, to } = useTimeRange();

  const ah = otel.alloyHistogram;
  const svcFilter = environment
    ? `${ah.appLabel}="${sanitizeLabelValue(service)}", job="${ah.job}", ${ah.envLabel}="${sanitizeLabelValue(environment)}"`
    : `${ah.appLabel}="${sanitizeLabelValue(service)}", job="${ah.job}"`;

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from, to });
    const mDs = { uid: ds.metricsUid };
    const lDs = { uid: ds.logsUid };

    // --- Row 1: Core Web Vitals stat panels (p75 from histograms) ---
    const lcpQ = makePromQuery(
      mDs,
      `histogram_quantile(0.75, sum(rate(${ah.lcp}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
      'LCP',
      { instant: true }
    );
    const fcpQ = makePromQuery(
      mDs,
      `histogram_quantile(0.75, sum(rate(${ah.fcp}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
      'FCP',
      { instant: true }
    );
    const clsQ = makePromQuery(
      mDs,
      `histogram_quantile(0.75, sum(rate(${ah.cls}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
      'CLS',
      { instant: true }
    );
    const inpQ = makePromQuery(
      mDs,
      `histogram_quantile(0.75, sum(rate(${ah.inp}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
      'INP',
      { instant: true }
    );
    const ttfbQ = makePromQuery(
      mDs,
      `histogram_quantile(0.75, sum(rate(${ah.ttfb}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
      'TTFB',
      { instant: true }
    );

    const vitalsRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('LCP (p75)', 'Largest Contentful Paint — target < 2500ms', lcpQ, 'ms', VITAL_THRESHOLDS.lcp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('FCP (p75)', 'First Contentful Paint — target < 1800ms', fcpQ, 'ms', VITAL_THRESHOLDS.fcp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('CLS (p75)', 'Cumulative Layout Shift — target < 0.1', clsQ, 'none', VITAL_THRESHOLDS.cls, 3),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('INP (p75)', 'Interaction to Next Paint — target < 200ms', inpQ, 'ms', VITAL_THRESHOLDS.inp),
        }),
        new SceneFlexItem({
          minHeight: 130,
          body: statPanel('TTFB (p75)', 'Time to First Byte — target < 800ms', ttfbQ, 'ms', VITAL_THRESHOLDS.ttfb),
        }),
      ],
    });

    // --- Row 2: Overview stats ---
    const overviewChildren: SceneFlexItem[] = [
      new SceneFlexItem({
        minHeight: 100,
        body: PanelBuilders.stat()
          .setTitle('Page Loads/s')
          .setDescription('Page load rate from histogram counter')
          .setData(makePromQuery(mDs, `sum(rate(${ah.pageLoads}{${svcFilter}}[$__rate_interval]))`, 'Rate'))
          .setUnit('reqps')
          .setColor({ mode: 'fixed', fixedColor: 'blue' } as any)
          .build(),
      }),
      new SceneFlexItem({
        minHeight: 100,
        body: PanelBuilders.stat()
          .setTitle('JS Errors/s')
          .setDescription('JavaScript error rate from counter')
          .setData(makePromQuery(mDs, `sum(rate(${ah.errors}{${svcFilter}}[$__rate_interval]))`, 'Rate'))
          .setUnit('reqps')
          .setColor({ mode: 'fixed', fixedColor: 'red' } as any)
          .build(),
      }),
    ];
    // Add Loki-backed session count if available
    if (hasLoki) {
      overviewChildren.push(
        new SceneFlexItem({
          minHeight: 100,
          body: PanelBuilders.stat()
            .setTitle('Sessions')
            .setDescription('Unique user sessions started (from Loki)')
            .setData(makeLokiQuery(lDs, lokiSessionStartExpr(service, '[$__range]'), 'Sessions', { instant: true }))
            .setUnit('short')
            .setColor({ mode: 'fixed', fixedColor: 'purple' } as any)
            .build(),
        })
      );
    }
    const overviewRow = new SceneFlexLayout({ direction: 'row', children: overviewChildren });

    // --- Row 3: Vitals time series trends (p75 over time) ---
    const pageLoadVitalsQ = new SceneQueryRunner({
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
    const inpTrendQ = makePromQuery(
      mDs,
      `histogram_quantile(0.75, sum(rate(${ah.inp}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
      'INP'
    );
    const clsTrendQ = makePromQuery(
      mDs,
      `histogram_quantile(0.75, sum(rate(${ah.cls}_bucket{${svcFilter}}[$__rate_interval])) by (le))`,
      'CLS'
    );

    const trendsRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('Page Load Vitals (p75)')
            .setDescription('TTFB → FCP → LCP loading sequence over time')
            .setData(pageLoadVitalsQ)
            .setUnit('ms')
            .build(),
        }),
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('Interactivity (INP p75)')
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
            .setTitle('Layout Stability (CLS p75)')
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

    // --- Row 4: Traffic trends (page loads + errors from counters) ---
    const pageLoadsQ = makePromQuery(mDs, `sum(rate(${ah.pageLoads}{${svcFilter}}[$__rate_interval]))`, 'Page Loads/s');
    const errQ = makePromQuery(mDs, `sum(rate(${ah.errors}{${svcFilter}}[$__rate_interval]))`, 'JS Errors/s');
    const trafficRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('Page Loads')
            .setDescription('Page load rate over time')
            .setData(pageLoadsQ)
            .setUnit('reqps')
            .setCustomFieldConfig('fillOpacity', 30)
            .build(),
        }),
        new SceneFlexItem({
          minHeight: 200,
          body: PanelBuilders.timeseries()
            .setTitle('JavaScript Errors')
            .setDescription('JS error rate over time')
            .setData(errQ)
            .setUnit('reqps')
            .setCustomFieldConfig('fillOpacity', 15)
            .build(),
        }),
      ],
    });

    // --- Row 5: Browser distribution from counter metrics ---
    const browserPieQ = makePromQuery(
      mDs,
      `sum by (${ah.browserLabel}) (increase(${ah.pageLoads}{${svcFilter}}[$__range]))`,
      '{{browser_name}}'
    );
    const browserPie = new SceneFlexItem({
      minHeight: 200,
      body: PanelBuilders.piechart()
        .setTitle('Browser Distribution')
        .setDescription('Page loads by browser (from metrics counter)')
        .setData(browserPieQ)
        .build(),
    });

    // Navigation type distribution
    const navPieQ = makePromQuery(
      mDs,
      `sum by (${ah.navTypeLabel}) (increase(${ah.pageLoadsByNav}{${svcFilter}}[$__range]))`,
      '{{nav_type}}'
    );
    const navPie = new SceneFlexItem({
      minHeight: 200,
      body: PanelBuilders.piechart()
        .setTitle('Navigation Type')
        .setDescription('Page loads by navigation type (navigate, reload, back-forward)')
        .setData(navPieQ)
        .build(),
    });

    const breakdownRow = new SceneFlexLayout({ direction: 'row', children: [browserPie, navPie] });

    // --- Loki-backed enrichment rows (only if Loki data available) ---
    const lokiRows: Array<SceneFlexLayout | SceneFlexItem> = [];

    if (hasLoki) {
      // Per-Page Performance Table
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
      lokiRows.push(
        new SceneFlexItem({
          minHeight: 250,
          body: PanelBuilders.table()
            .setTitle('Per-Page Performance')
            .setDescription('Average Web Vitals per page route (from Loki logs)')
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
              b.matchFieldsWithName('Value #count').overrideDisplayName('Measurements').overrideDecimals(0);
              b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
            })
            .build(),
        })
      );

      // Top Exceptions + Console Errors
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
        ],
      });
      const consoleErrorsQ = makeLokiQuery(lDs, lokiConsoleErrorsExpr(service, '[$__range]'), '{{value}}', {
        instant: true,
      });
      lokiRows.push(
        new SceneFlexLayout({
          direction: 'row',
          children: [
            new SceneFlexItem({
              minHeight: 250,
              body: PanelBuilders.table()
                .setTitle('Top Exceptions')
                .setDescription('Most frequent JS exceptions (from Loki)')
                .setData(topExceptionsQ)
                .setOverrides((b) => {
                  b.matchFieldsWithName('value').overrideDisplayName('Error').overrideCustomFieldConfig('width', 500);
                  b.matchFieldsWithName('Value #count').overrideDisplayName('Occurrences');
                  b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
                  b.matchFieldsWithName('value').overrideLinks([
                    {
                      title: 'Explore in Loki',
                      url: buildExploreUrl({
                        datasourceUid: ds.logsUid,
                        queries: [
                          {
                            refId: 'A',
                            expr: `{${otel.faroLoki.serviceName}="${sanitizeLabelValue(service)}", ${otel.faroLoki.kind}="${otel.faroLoki.kindException}"} | logfmt | value=\`\${__data.fields.value}\``,
                          },
                        ],
                        range: { from: '${__from:date:iso}', to: '${__to:date:iso}' },
                      }),
                      targetBlank: true,
                    } as any,
                  ]);
                })
                .build(),
            }),
            new SceneFlexItem({
              minHeight: 250,
              body: PanelBuilders.table()
                .setTitle('Console Errors')
                .setDescription('Most frequent console.error messages (from Loki)')
                .setData(consoleErrorsQ)
                .setOverrides((b) => {
                  b.matchFieldsWithName('value').overrideDisplayName('Error Message');
                  b.matchFieldsWithName('Value').overrideDisplayName('Count');
                  b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
                })
                .build(),
            }),
          ],
        })
      );
    }

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
          overviewRow,
          trendsRow,
          trafficRow,
          breakdownRow,
          ...lokiRows,
        ],
      }),
    });
  }, [from, to, ds, svcFilter, ah, showVitalsRow, vitals, hasLoki, service]);

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
