import React from 'react';
import { useStyles2, Alert, LinkButton, Icon } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';

interface FrontendTabProps {
  service: string;
  namespace: string;
}

/**
 * Frontend tab — shows browser/RUM observability data collected by Grafana Faro
 * or OpenTelemetry browser instrumentation.
 *
 * Currently a capability-driven placeholder: when Faro data is detected for the
 * service, this tab will show Web Vitals (LCP, FCP, CLS, INP, TTFB), JS error
 * rates, and page load distributions. When no browser telemetry is available,
 * it shows setup instructions.
 */
export function FrontendTab({ service, namespace }: FrontendTabProps) {
  const styles = useStyles2(getStyles);

  return (
    <div className={styles.container}>
      <Alert severity="info" title="Frontend Observability">
        <p>
          No browser telemetry data found for <strong>{namespace}/{service}</strong>.
        </p>
        <p>
          To collect frontend observability data (Web Vitals, JS errors, page loads),
          instrument your web application with{' '}
          <a
            href="https://grafana.com/docs/faro-web-sdk/latest/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Grafana Faro Web SDK
          </a>{' '}
          or the{' '}
          <a
            href="https://opentelemetry.io/docs/languages/js/getting-started/browser/"
            target="_blank"
            rel="noopener noreferrer"
          >
            OpenTelemetry Browser SDK
          </a>
          .
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
            description="LCP, FCP, CLS, INP, TTFB — track real user experience metrics"
          />
          <FeatureCard
            icon="bug"
            title="JavaScript Errors"
            description="Error rates, stack traces, and error grouping from the browser"
          />
          <FeatureCard
            icon="clock-nine"
            title="Page Load Performance"
            description="Navigation timing, resource loading, and time-to-interactive"
          />
          <FeatureCard
            icon="gf-traces"
            title="Frontend Traces"
            description="Distributed traces from browser → API → backend services"
          />
        </div>
      </div>

      <div className={styles.setupSteps}>
        <h4 className={styles.featuresTitle}>Quick Setup</h4>
        <ol className={styles.steps}>
          <li>
            Install Grafana Faro: <code>npm install @grafana/faro-web-sdk</code>
          </li>
          <li>
            Initialize Faro in your app entrypoint with your collector endpoint
          </li>
          <li>
            Configure the OTel Collector to receive and forward browser telemetry
          </li>
          <li>
            Reload this page — the Frontend tab will populate automatically
          </li>
        </ol>
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
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
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
    max-width: 800px;
  `,
  features: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1.5)};
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
  setupSteps: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1.5)};
  `,
  steps: css`
    margin: 0;
    padding-left: ${theme.spacing(3)};
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.body.fontSize};

    code {
      background: ${theme.colors.background.canvas};
      padding: 2px 6px;
      border-radius: 3px;
      font-size: ${theme.typography.bodySmall.fontSize};
    }
  `,
});
