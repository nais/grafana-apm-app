import React, { useEffect, useState } from 'react';
import { PluginPage } from '@grafana/runtime';
import { Alert, LoadingPlaceholder, LinkButton, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getServices, getCapabilities, ServiceSummary, Capabilities } from '../api/client';
import { PLUGIN_BASE_URL } from '../constants';

function ServiceInventory() {
  const styles = useStyles2(getStyles);
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const now = Date.now();
        const [capsResult, servicesResult] = await Promise.all([
          getCapabilities(),
          getServices(now - 3600000, now, 60, true),
        ]);
        setCaps(capsResult);
        setServices(servicesResult);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load services');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  return (
    <PluginPage>
      <div className={styles.container}>
        {error && <Alert severity="error" title="Error">{error}</Alert>}
        {loading && <LoadingPlaceholder text="Loading services..." />}

        {!loading && caps && !caps.spanMetrics.detected && (
          <Alert severity="warning" title="No span metrics detected">
            Ensure the OpenTelemetry Collector spanmetrics connector is configured and sending data to Mimir.
          </Alert>
        )}

        {!loading && services.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Service</th>
                <th>Namespace</th>
                <th>Rate (req/s)</th>
                <th>Error Rate</th>
                <th>P95 Duration</th>
                <th>Rate Trend</th>
              </tr>
            </thead>
            <tbody>
              {services.map((svc) => (
                <tr key={`${svc.namespace}/${svc.name}`} className={styles.row}>
                  <td>
                    <LinkButton
                      variant="secondary"
                      fill="text"
                      href={`${PLUGIN_BASE_URL}/services/${encodeURIComponent(svc.namespace)}/${encodeURIComponent(svc.name)}`}
                    >
                      {svc.name}
                    </LinkButton>
                  </td>
                  <td>{svc.namespace}</td>
                  <td>{svc.rate.toFixed(2)}</td>
                  <td className={svc.errorRate > 0 ? styles.errorText : ''}>
                    {svc.errorRate.toFixed(1)}%
                  </td>
                  <td>
                    {svc.p95Duration.toFixed(1)} {svc.durationUnit}
                  </td>
                  <td>
                    {svc.rateSeries && svc.rateSeries.length > 0 && (
                      <MiniSparkline data={svc.rateSeries.map((p) => p.v)} color="#73BF69" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && services.length === 0 && caps?.spanMetrics.detected && (
          <Alert severity="info" title="No services found">
            Span metrics are detected but no server spans were found. Make sure your services send traces with span_kind=SPAN_KIND_SERVER.
          </Alert>
        )}
      </div>
    </PluginPage>
  );
}

function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) {
    return null;
  }
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const width = 120;
  const height = 24;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
    </svg>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    padding: ${theme.spacing(2)};
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    th {
      text-align: left;
      padding: ${theme.spacing(1)} ${theme.spacing(2)};
      border-bottom: 1px solid ${theme.colors.border.medium};
      color: ${theme.colors.text.secondary};
      font-size: ${theme.typography.bodySmall.fontSize};
    }
    td {
      padding: ${theme.spacing(1)} ${theme.spacing(2)};
      border-bottom: 1px solid ${theme.colors.border.weak};
    }
  `,
  row: css`
    &:hover {
      background: ${theme.colors.background.secondary};
    }
  `,
  errorText: css`
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
});

export default ServiceInventory;
