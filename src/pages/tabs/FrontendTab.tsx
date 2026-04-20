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
  PanelBuilders,
  EmbeddedScene,
  behaviors,
} from '@grafana/scenes';
import { DashboardCursorSync } from '@grafana/schema';
import { getFrontendMetrics } from '../../api/client';
import { usePluginDatasources } from '../../utils/datasources';
import { useTimeRange } from '../../utils/timeRange';

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

// ---- Web Vitals panels (Scenes) ----

function WebVitalsPanels({ service, namespace }: { service: string; namespace: string }) {
  const ds = usePluginDatasources();
  const { from, to } = useTimeRange();

  const svcFilter = `service_name="${service}", service_namespace="${namespace}"`;

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from, to });

    const lcpQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [{ refId: 'A', expr: `avg(browser_web_vitals_lcp_milliseconds{${svcFilter}})`, legendFormat: 'LCP' }],
    });
    const fcpQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [{ refId: 'A', expr: `avg(browser_web_vitals_fcp_milliseconds{${svcFilter}})`, legendFormat: 'FCP' }],
    });
    const clsQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [{ refId: 'A', expr: `avg(browser_web_vitals_cls{${svcFilter}})`, legendFormat: 'CLS' }],
    });
    const inpQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [{ refId: 'A', expr: `avg(browser_web_vitals_inp_milliseconds{${svcFilter}})`, legendFormat: 'INP' }],
    });
    const ttfbQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [{ refId: 'A', expr: `avg(browser_web_vitals_ttfb_milliseconds{${svcFilter}})`, legendFormat: 'TTFB' }],
    });

    const errQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      minInterval: '5m',
      queries: [{ refId: 'A', expr: `sum(rate(browser_errors_total{${svcFilter}}[$__rate_interval]))`, legendFormat: 'JS Errors/s' }],
    });

    const pageLoadQuery = new SceneQueryRunner({
      datasource: { uid: ds.metricsUid, type: 'prometheus' },
      queries: [{
        refId: 'A',
        expr: `sum by (le) (increase(browser_page_load_duration_milliseconds_bucket{${svcFilter}}[$__range]))`,
        format: 'heatmap',
        legendFormat: '{{le}}',
      }],
    });

    return new EmbeddedScene({
      $timeRange: timeRange,
      $behaviors: [new behaviors.CursorSync({ sync: DashboardCursorSync.Crosshair })],
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          // Core Web Vitals row
          new SceneFlexLayout({
            direction: 'row',
            children: [
              new SceneFlexItem({
                minHeight: 160,
                body: PanelBuilders.stat()
                  .setTitle('LCP')
                  .setDescription('Largest Contentful Paint — target < 2500ms')
                  .setData(lcpQuery)
                  .setUnit('ms')
                  .setOverrides((b) => b.matchFieldsWithName('LCP')
                    .overrideThresholds({
                      mode: ThresholdsMode.Absolute,
                      steps: [
                        { value: 0, color: 'green' },
                        { value: 2500, color: 'orange' },
                        { value: 4000, color: 'red' },
                      ],
                    }))
                  .build(),
              }),
              new SceneFlexItem({
                minHeight: 160,
                body: PanelBuilders.stat()
                  .setTitle('FCP')
                  .setDescription('First Contentful Paint — target < 1800ms')
                  .setData(fcpQuery)
                  .setUnit('ms')
                  .setOverrides((b) => b.matchFieldsWithName('FCP')
                    .overrideThresholds({
                      mode: ThresholdsMode.Absolute,
                      steps: [
                        { value: 0, color: 'green' },
                        { value: 1800, color: 'orange' },
                        { value: 3000, color: 'red' },
                      ],
                    }))
                  .build(),
              }),
              new SceneFlexItem({
                minHeight: 160,
                body: PanelBuilders.stat()
                  .setTitle('CLS')
                  .setDescription('Cumulative Layout Shift — target < 0.1')
                  .setData(clsQuery)
                  .setUnit('none')
                  .setDecimals(3)
                  .setOverrides((b) => b.matchFieldsWithName('CLS')
                    .overrideThresholds({
                      mode: ThresholdsMode.Absolute,
                      steps: [
                        { value: 0, color: 'green' },
                        { value: 0.1, color: 'orange' },
                        { value: 0.25, color: 'red' },
                      ],
                    }))
                  .build(),
              }),
              new SceneFlexItem({
                minHeight: 160,
                body: PanelBuilders.stat()
                  .setTitle('INP')
                  .setDescription('Interaction to Next Paint — target < 200ms')
                  .setData(inpQuery)
                  .setUnit('ms')
                  .setOverrides((b) => b.matchFieldsWithName('INP')
                    .overrideThresholds({
                      mode: ThresholdsMode.Absolute,
                      steps: [
                        { value: 0, color: 'green' },
                        { value: 200, color: 'orange' },
                        { value: 500, color: 'red' },
                      ],
                    }))
                  .build(),
              }),
              new SceneFlexItem({
                minHeight: 160,
                body: PanelBuilders.stat()
                  .setTitle('TTFB')
                  .setDescription('Time to First Byte — target < 800ms')
                  .setData(ttfbQuery)
                  .setUnit('ms')
                  .setOverrides((b) => b.matchFieldsWithName('TTFB')
                    .overrideThresholds({
                      mode: ThresholdsMode.Absolute,
                      steps: [
                        { value: 0, color: 'green' },
                        { value: 800, color: 'orange' },
                        { value: 1800, color: 'red' },
                      ],
                    }))
                  .build(),
              }),
            ],
          }),
          // JS Errors + Page Load row
          new SceneFlexLayout({
            direction: 'row',
            children: [
              new SceneFlexItem({
                minHeight: 200,
                body: PanelBuilders.timeseries()
                  .setTitle('JavaScript Errors')
                  .setData(errQuery)
                  .setUnit('short')
                  .build(),
              }),
              new SceneFlexItem({
                minHeight: 200,
                body: PanelBuilders.histogram()
                  .setTitle('Page Load Duration')
                  .setData(pageLoadQuery)
                  .setUnit('ms')
                  .build(),
              }),
            ],
          }),
        ],
      }),
    });
  }, [service, namespace, from, to, ds, svcFilter]);

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
