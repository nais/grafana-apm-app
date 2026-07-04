import React, { useEffect, useMemo, useState } from 'react';
import { useStyles2, Alert, LinkButton, Icon, LoadingPlaceholder } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import {
  SceneFlexLayout,
  SceneFlexItem,
  SceneTimeRange,
  SceneVariableSet,
  CustomVariable,
  VariableValueSelectors,
  EmbeddedScene,
  SceneReactObject,
  behaviors,
} from '@grafana/scenes';
import { DashboardCursorSync } from '@grafana/schema';
import { getFrontendMetrics } from '../../api/client';
import { usePluginDatasources, usePluginLabelOverrides } from '../../utils/datasources';
import { useTimeRange } from '../../utils/timeRange';
import { useSceneTimeSync } from '../../utils/useSceneTimeSync';
import { sanitizeLabelValue } from '../../utils/sanitize';
import { otel } from '../../otelconfig';
import { buildDeployAnnotationsLayer } from '../buildServiceScene';
import { ExceptionDrawer } from './frontend/components/ExceptionDrawer';
import { useExceptionDrawerState } from './frontend/useExceptionDrawer';

import {
  WebVitalsBullets,
  histogramFilter,
  buildInsightsSection,
  buildTrendsSection,
  buildPerPageSection,
  buildErrorsSection,
  buildBrowserBreakdownSection,
  buildSupportSection,
  buildTrafficSection,
  type FrontendSceneContext,
} from './frontend';
import { buildAttributionSection } from './frontend/attribution';

interface FrontendTabProps {
  service: string;
  namespace: string;
  environment?: string;
}

export function FrontendTab({ service, namespace, environment }: FrontendTabProps) {
  const styles = useStyles2(getStyles);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [hasLoki, setHasLoki] = useState<boolean>(false);
  const [vitals, setVitals] = useState<Record<string, number> | undefined>();
  const ds = usePluginDatasources(environment || undefined);
  const { from, to } = useTimeRange();
  // Shared with the Issues tab (#69 P1/P10) — an issueId deep link opens the
  // drawer identically on both tabs.
  const {
    drawerHashes,
    selectedGroupTitle,
    selectedIssueId,
    selectedHash,
    selectedSessionId,
    setSelectedSessionId,
    closeDrawer,
  } = useExceptionDrawerState(namespace, service, environment);

  useEffect(() => {
    let cancelled = false;

    getFrontendMetrics(namespace, service, environment || undefined)
      .then((r) => {
        if (cancelled) {
          return;
        }
        setAvailable(r.available);
        setHasLoki(r.hasLoki ?? false);
        setVitals(r.vitals);
      })
      .catch(() => {
        if (!cancelled) {
          setAvailable(false);
          setHasLoki(false);
          setVitals(undefined);
        }
      });

    return () => {
      cancelled = true;
      setAvailable(null);
      setHasLoki(false);
      setVitals(undefined);
    };
  }, [service, namespace, environment]);

  if (available === null) {
    return <LoadingPlaceholder text="Checking for browser telemetry..." />;
  }

  if (!available) {
    return <SetupPlaceholder namespace={namespace} service={service} />;
  }

  const noRecentData = !vitals || Object.keys(vitals).length === 0;

  return (
    <div className={styles.container}>
      {noRecentData && (
        <Alert severity="info" title="No recent measurements">
          This service is instrumented but has no browser telemetry in the current time range. Try widening the time
          range or wait for new traffic.
        </Alert>
      )}
      <FrontendPanels
        service={service}
        namespace={namespace}
        environment={environment}
        vitals={vitals}
        hasLoki={hasLoki}
        from={from}
        to={to}
      />
      {drawerHashes && drawerHashes.length > 0 && (
        <ExceptionDrawer
          key={selectedIssueId || selectedHash}
          hashes={drawerHashes}
          title={selectedGroupTitle}
          service={service}
          namespace={namespace}
          environment={environment}
          logsUid={ds.logsUid}
          selectedSessionId={selectedSessionId}
          onSessionChange={setSelectedSessionId}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}

// ========================================================================
// Frontend Panels — Mimir-first layout with optional Loki enrichment.
// All core metrics (vitals, ratings, traffic) come from Mimir histograms.
// Loki adds per-page breakdowns, full error messages, and session data.
// ========================================================================

function FrontendPanels({
  service,
  namespace,
  environment,
  vitals,
  hasLoki,
  from,
  to,
}: {
  service: string;
  namespace: string;
  environment?: string;
  from: string;
  to: string;
  vitals?: Record<string, number>;
  hasLoki: boolean;
}) {
  const ds = usePluginDatasources(environment || undefined);
  const labelOverrides = usePluginLabelOverrides();

  const ah = otel.alloyHistogram;
  const svcFilter = histogramFilter(
    sanitizeLabelValue(service),
    environment ? sanitizeLabelValue(environment) : undefined
  );

  const scene = useMemo(() => {
    const ctx: FrontendSceneContext = {
      metricsDs: { uid: ds.metricsUid },
      logsDs: { uid: ds.logsUid },
      service,
      namespace,
      environment,
      svcFilter,
      hasLoki,
      ah,
      clusterFilter: !ds.isLogsEnvSpecific && environment ? environment : undefined,
      clusterLabel: labelOverrides.deploymentEnvLabel,
    };

    // Build sections — core metrics always render, Loki enrichment is optional
    const insightsRow = buildInsightsSection(ctx);
    const trendsRow = buildTrendsSection(ctx);
    const perPageTable = buildPerPageSection(ctx);
    const errorsRow = buildErrorsSection(ctx);
    const browserBreakdownRow = buildBrowserBreakdownSection(ctx);
    const attributionRow = buildAttributionSection(ctx);
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
      value: '$__all',
    });

    // Bullet chart summary (pre-computed by backend)
    const bulletsItem = vitals
      ? new SceneFlexItem({
          body: new SceneReactObject({ reactNode: <WebVitalsBullets vitals={vitals} /> }),
        })
      : null;

    return new EmbeddedScene({
      // Synced to the shared URL time range (was hardcoded now-1h, which left
      // scene panels and the drawer/issues table querying different windows).
      $timeRange: new SceneTimeRange({ from, to }),
      // Deploy markers (#64): annotation layer inherited by all child panels.
      $data: buildDeployAnnotationsLayer(service, environment),
      $variables: new SceneVariableSet({ variables: [browserVar] }),
      $behaviors: [new behaviors.CursorSync({ sync: DashboardCursorSync.Crosshair })],
      // Global header owns time controls; the browser variable stays.
      controls: [new VariableValueSelectors({})],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          ...(bulletsItem ? [bulletsItem] : []),
          insightsRow,
          // Vitals-first (#69 P6): the tab's primary question is "is the UX
          // healthy?" — issues stays as one compact browser-scoped row (full
          // triage moved to the Issues tab) so the trends below aren't pushed
          // down by a tall table.
          errorsRow,
          trendsRow,
          // Web-vitals attribution: which LCP element / interaction / layout
          // shift is responsible — right after the vitals trends they explain.
          ...(attributionRow ? [attributionRow] : []),
          ...(perPageTable ? [perPageTable] : []),
          ...(browserBreakdownRow ? [browserBreakdownRow] : []),
          trafficRow,
          ...(supportRow ? [supportRow] : []),
        ],
      }),
    });
  }, [ds, service, namespace, environment, svcFilter, ah, hasLoki, vitals, labelOverrides, from, to]);
  // Header refresh of a relative range re-resolves fromMs/toMs while the raw
  // strings stay put — re-query the live scene instead of rebuilding it.
  const { fromMs, toMs } = useTimeRange();
  useSceneTimeSync(scene, fromMs, toMs);

  return <scene.Component model={scene} />;
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
