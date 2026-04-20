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
import { DashboardCursorSync } from '@grafana/schema';
import { getFrontendMetrics } from '../../api/client';
import { usePluginDatasources } from '../../utils/datasources';
import { useTimeRange } from '../../utils/timeRange';
import { sanitizeLabelValue } from '../../utils/sanitize';

interface FrontendTabProps {
  service: string;
  namespace: string;
}

export function FrontendTab({ service, namespace }: FrontendTabProps) {
  const styles = useStyles2(getStyles);
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    getFrontendMetrics(namespace, service)
      .then((r) => setAvailable(r.available))
      .catch(() => setAvailable(false));
  }, [service, namespace]);

  if (available === null) {
    return <LoadingPlaceholder text="Checking for browser telemetry..." />;
  }

  if (!available) {
    return <SetupPlaceholder namespace={namespace} service={service} />;
  }

  return (
    <div className={styles.container}>
      <WebVitalsPanels service={service} namespace={namespace} />
    </div>
  );
}

// ---- helpers ----

function statPanel(title: string, description: string, query: SceneQueryRunner, unit: string, thresholds: Array<{ value: number; color: string }>, decimals?: number) {
  const builder = PanelBuilders.stat()
    .setTitle(title)
    .setDescription(description)
    .setData(query)
    .setUnit(unit);
  if (decimals !== undefined) {
    builder.setDecimals(decimals);
  }
  return builder
    .setOverrides((b) => b.matchFieldsWithName(title)
      .overrideThresholds({
        mode: ThresholdsMode.Absolute,
        steps: thresholds.map((t) => ({ value: t.value, color: t.color })),
      }))
    .build();
}

function makeQuery(ds: { uid: string }, expr: string, legendFormat: string, opts?: { minInterval?: string; format?: string }) {
  return new SceneQueryRunner({
    datasource: { uid: ds.uid, type: 'prometheus' },
    ...(opts?.minInterval ? { minInterval: opts.minInterval } : {}),
    queries: [{
      refId: 'A',
      expr,
      legendFormat,
      ...(opts?.format ? { format: opts.format } : {}),
    }],
  });
}

// ---- Web Vitals panels (Scenes) ----

function WebVitalsPanels({ service, namespace }: { service: string; namespace: string }) {
  const ds = usePluginDatasources();
  const { from, to } = useTimeRange();

  const svcFilter = `service_name="${sanitizeLabelValue(service)}", service_namespace="${sanitizeLabelValue(namespace)}"`;

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from, to });
    const mDs = { uid: ds.metricsUid };

    // --- Row 1: Core Web Vitals stat panels ---
    const lcpQ = makeQuery(mDs, `avg(browser_web_vitals_lcp_milliseconds{${svcFilter}})`, 'LCP');
    const fcpQ = makeQuery(mDs, `avg(browser_web_vitals_fcp_milliseconds{${svcFilter}})`, 'FCP');
    const clsQ = makeQuery(mDs, `avg(browser_web_vitals_cls{${svcFilter}})`, 'CLS');
    const inpQ = makeQuery(mDs, `avg(browser_web_vitals_inp_milliseconds{${svcFilter}})`, 'INP');
    const ttfbQ = makeQuery(mDs, `avg(browser_web_vitals_ttfb_milliseconds{${svcFilter}})`, 'TTFB');

    const vitalsRow = new SceneFlexLayout({
      direction: 'row',
      children: [
        new SceneFlexItem({ minHeight: 130, body: statPanel('LCP', 'Largest Contentful Paint — target < 2500ms', lcpQ, 'ms', [{ value: 0, color: 'green' }, { value: 2500, color: 'orange' }, { value: 4000, color: 'red' }]) }),
        new SceneFlexItem({ minHeight: 130, body: statPanel('FCP', 'First Contentful Paint — target < 1800ms', fcpQ, 'ms', [{ value: 0, color: 'green' }, { value: 1800, color: 'orange' }, { value: 3000, color: 'red' }]) }),
        new SceneFlexItem({ minHeight: 130, body: statPanel('CLS', 'Cumulative Layout Shift — target < 0.1', clsQ, 'none', [{ value: 0, color: 'green' }, { value: 0.1, color: 'orange' }, { value: 0.25, color: 'red' }], 3) }),
        new SceneFlexItem({ minHeight: 130, body: statPanel('INP', 'Interaction to Next Paint — target < 200ms', inpQ, 'ms', [{ value: 0, color: 'green' }, { value: 200, color: 'orange' }, { value: 500, color: 'red' }]) }),
        new SceneFlexItem({ minHeight: 130, body: statPanel('TTFB', 'Time to First Byte — target < 800ms', ttfbQ, 'ms', [{ value: 0, color: 'green' }, { value: 800, color: 'orange' }, { value: 1800, color: 'red' }]) }),
      ],
    });

    // --- Row 2: Web Vitals P75 time series ---
    const pageLoadVitalsQ = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [
        { refId: 'A', expr: `avg(browser_web_vitals_ttfb_milliseconds{${svcFilter}})`, legendFormat: 'TTFB' },
        { refId: 'B', expr: `avg(browser_web_vitals_fcp_milliseconds{${svcFilter}})`, legendFormat: 'FCP' },
        { refId: 'C', expr: `avg(browser_web_vitals_lcp_milliseconds{${svcFilter}})`, legendFormat: 'LCP' },
      ],
    });
    const inpTrendQ = makeQuery(mDs, `avg(browser_web_vitals_inp_milliseconds{${svcFilter}})`, 'INP');
    const clsTrendQ = makeQuery(mDs, `avg(browser_web_vitals_cls{${svcFilter}})`, 'CLS');

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
            .build(),
        }),
      ],
    });

    // --- Row 3: Page Loads Over Time + JS Errors ---
    const pageLoadsQ = makeQuery(
      mDs,
      `sum by (page_route) (increase(browser_page_loads_total{${svcFilter}}[$__rate_interval]))`,
      '{{page_route}}',
      { minInterval: '1m' }
    );
    const errQ = makeQuery(
      mDs,
      `sum(rate(browser_errors_total{${svcFilter}}[$__rate_interval]))`,
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
        { refId: 'lcp', expr: `avg by (page_route) (browser_web_vitals_lcp_milliseconds{${svcFilter}})`, legendFormat: '__auto', format: 'table', instant: true },
        { refId: 'fcp', expr: `avg by (page_route) (browser_web_vitals_fcp_milliseconds{${svcFilter}})`, legendFormat: '__auto', format: 'table', instant: true },
        { refId: 'cls', expr: `avg by (page_route) (browser_web_vitals_cls{${svcFilter}})`, legendFormat: '__auto', format: 'table', instant: true },
        { refId: 'inp', expr: `avg by (page_route) (browser_web_vitals_inp_milliseconds{${svcFilter}})`, legendFormat: '__auto', format: 'table', instant: true },
        { refId: 'ttfb', expr: `avg by (page_route) (browser_web_vitals_ttfb_milliseconds{${svcFilter}})`, legendFormat: '__auto', format: 'table', instant: true },
        { refId: 'loads', expr: `sum by (page_route) (increase(browser_page_loads_total{${svcFilter}}[$__range]))`, legendFormat: '__auto', format: 'table', instant: true },
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
          b.matchFieldsWithName('Value #lcp').overrideDisplayName('LCP (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: [{ value: 0, color: 'green' }, { value: 2500, color: 'orange' }, { value: 4000, color: 'red' }] })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #fcp').overrideDisplayName('FCP (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: [{ value: 0, color: 'green' }, { value: 1800, color: 'orange' }, { value: 3000, color: 'red' }] })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #cls').overrideDisplayName('CLS')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: [{ value: 0, color: 'green' }, { value: 0.1, color: 'orange' }, { value: 0.25, color: 'red' }] })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(3);
          b.matchFieldsWithName('Value #inp').overrideDisplayName('INP (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: [{ value: 0, color: 'green' }, { value: 200, color: 'orange' }, { value: 500, color: 'red' }] })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #ttfb').overrideDisplayName('TTFB (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: [{ value: 0, color: 'green' }, { value: 800, color: 'orange' }, { value: 1800, color: 'red' }] })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #loads').overrideDisplayName('Page Loads').overrideDecimals(0);
          b.matchFieldsWithName('page_route').overrideDisplayName('Page Route');
          // Hide Time columns
          b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
        })
        .build(),
    });

    // --- Row 5: Browser Breakdown ---
    const browserQ = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [
        { refId: 'lcp', expr: `avg by (browser_name) (browser_web_vitals_lcp_milliseconds{${svcFilter}})`, legendFormat: '__auto', format: 'table', instant: true },
        { refId: 'loads', expr: `sum by (browser_name) (increase(browser_page_loads_total{${svcFilter}}[$__range]))`, legendFormat: '__auto', format: 'table', instant: true },
        { refId: 'errors', expr: `sum by (browser_name) (increase(browser_errors_total{${svcFilter}, browser_name!=""}[$__range]))`, legendFormat: '__auto', format: 'table', instant: true },
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
          b.matchFieldsWithName('Value #lcp').overrideDisplayName('Avg LCP (ms)')
            .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: [{ value: 0, color: 'green' }, { value: 2500, color: 'orange' }, { value: 4000, color: 'red' }] })
            .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
            .overrideDecimals(0);
          b.matchFieldsWithName('Value #loads').overrideDisplayName('Page Loads').overrideDecimals(0);
          b.matchFieldsWithName('Value #errors').overrideDisplayName('JS Errors').overrideDecimals(0);
          b.matchFieldsWithName('Time').overrideCustomFieldConfig('hidden' as any, true);
        })
        .build(),
    });

    // --- Row 6: Page Load Duration Histogram ---
    const pageLoadHistQ = makeQuery(
      mDs,
      `sum by (le) (increase(browser_page_load_duration_milliseconds_bucket{${svcFilter}}[$__range]))`,
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
      children: [
        histogramItem,
        browserTable,
      ],
    });

    return new EmbeddedScene({
      $timeRange: timeRange,
      $behaviors: [new behaviors.CursorSync({ sync: DashboardCursorSync.Crosshair })],
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          vitalsRow,
          trendsRow,
          trafficRow,
          perPageTable,
          bottomRow,
        ],
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
          No browser telemetry data found for <strong>{namespace}/{service}</strong>.
        </p>
        <p>
          Instrument your web application with{' '}
          <a href="https://grafana.com/docs/faro-web-sdk/latest/" target="_blank" rel="noopener noreferrer">
            Grafana Faro Web SDK
          </a>{' '}
          or the{' '}
          <a href="https://opentelemetry.io/docs/languages/js/getting-started/browser/" target="_blank" rel="noopener noreferrer">
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
          <FeatureCard icon="dashboard" title="Core Web Vitals" description="LCP, FCP, CLS, INP, TTFB — real user experience metrics" />
          <FeatureCard icon="bug" title="JavaScript Errors" description="Error rates, stack traces, and error grouping" />
          <FeatureCard icon="clock-nine" title="Page Load Performance" description="Navigation timing and time-to-interactive" />
          <FeatureCard icon="gf-traces" title="Frontend Traces" description="Distributed traces from browser → backend" />
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
