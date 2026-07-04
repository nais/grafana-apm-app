import React, { useState } from 'react';
import { Badge, Icon, LinkButton, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { CustomMetric, getCustomMetrics } from '../api/client';
import { useFetch } from '../utils/useFetch';
import { useTimeRange } from '../utils/timeRange';
import { usePluginDatasources } from '../utils/datasources';
import { buildMimirExploreUrl } from '../utils/explore';
import { escapeQueryString } from '../utils/sanitize';
import { otel } from '../otelconfig';
import { DataState } from './DataState';

interface CustomMetricsPanelProps {
  namespace: string;
  service: string;
  environment?: string;
}

type BadgeColor = React.ComponentProps<typeof Badge>['color'];

const TYPE_BADGE_COLOR: Record<string, BadgeColor> = {
  counter: 'blue',
  histogram: 'purple',
  gauge: 'green',
};

/**
 * Zero-config custom-metric discovery (#68 Phase 0): lists a service's
 * non-platform metric families straight from Mimir — type/help/unit from the
 * metadata API (suffix heuristics as fallback), series counts as the
 * cardinality guard — each row deep-linking to Explore with an auto-generated
 * PromQL query by metric type. Auto-charted Scenes panels are the Phase 0
 * follow-up; this section renders nothing when no custom metrics exist.
 *
 * Collapsible, default-collapsed, with the discovered-metric count in its
 * own header (IA review P9): the Overview budget is RED-first, so this
 * unbounded auto-discovered list shouldn't compete for attention until
 * curated (#68 P1). The count still requires the fetch, so that keeps
 * running unconditionally (existing `useFetch` above/below is unchanged) —
 * only the table (and any fetch error) stay hidden until expanded.
 */
export function CustomMetricsPanel({ namespace, service, environment }: CustomMetricsPanelProps) {
  const styles = useStyles2(getStyles);
  const { from, to, fromMs, toMs } = useTimeRange();
  const { metricsUid } = usePluginDatasources(environment);
  const [collapsed, setCollapsed] = useState(true);

  const { data, loading, error } = useFetch(
    () => getCustomMetrics(namespace, service, fromMs, toMs, environment),
    [namespace, service, fromMs, toMs, environment]
  );

  const metrics = data?.metrics ?? [];

  // Collapsed-when-empty: no section chrome at all when nothing is discovered.
  if (!loading && !error && metrics.length === 0) {
    return null;
  }

  const filter = runtimeFilter(service, namespace);
  // Errors are actionable feedback, not "the panel" — surface them even
  // while collapsed instead of silently hiding a failed fetch.
  const showBody = !collapsed || !!error;

  return (
    <div className={styles.container}>
      <div className={styles.header} onClick={() => setCollapsed((c) => !c)}>
        <Icon name={collapsed ? 'angle-right' : 'angle-down'} />
        <h6 className={styles.title}>Custom metrics{metrics.length > 0 ? ` (${metrics.length})` : ''}</h6>
        <span className={styles.subtitle}>Auto-discovered application metrics</span>
      </div>
      {showBody && (
        <DataState
          loading={loading}
          error={error ? 'Failed to load custom metrics' : null}
          empty={false}
          loadingText="Discovering custom metrics…"
        >
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Metric</th>
                <th>Type</th>
                <th className={styles.num}>Series</th>
                <th className={styles.actions}></th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <MetricRow
                  key={m.name}
                  metric={m}
                  exploreUrl={buildMimirExploreUrl(metricsUid, exploreQuery(m, filter), { from, to })}
                />
              ))}
            </tbody>
          </table>
          {data?.truncated && (
            <div className={styles.hint}>Showing the first {metrics.length} metric families — more exist.</div>
          )}
        </DataState>
      )}
    </div>
  );
}

function MetricRow({ metric, exploreUrl }: { metric: CustomMetric; exploreUrl: string }) {
  const styles = useStyles2(getStyles);
  return (
    <tr>
      <td className={styles.nameCell}>
        <span className={styles.name} title={metric.help || metric.name}>
          {metric.name}
        </span>
        {metric.unit && <span className={styles.unit}>{metric.unit}</span>}
        {metric.highCardinality && (
          <span className={styles.cardinalityHint}>high cardinality — not auto-charted, open in Explore</span>
        )}
      </td>
      <td>
        <Badge text={metric.type} color={TYPE_BADGE_COLOR[metric.type] ?? 'orange'} />
      </td>
      <td className={styles.num}>{metric.series}</td>
      <td className={styles.actions}>
        <LinkButton size="sm" variant="secondary" icon="compass" href={exploreUrl} target="_blank">
          Open in Explore
        </LinkButton>
      </td>
    </tr>
  );
}

/** app/namespace matcher for app-emitted metrics (mirrors backend RuntimeFilter). */
function runtimeFilter(service: string, namespace: string): string {
  let f = `${otel.runtime.appLabel}="${escapeQueryString(service)}"`;
  if (namespace) {
    f += `, ${otel.runtime.namespaceLabel}="${escapeQueryString(namespace)}"`;
  }
  return f;
}

/** Auto-generated PromQL by chart hint: counter→rate, histogram→p95, else gauge (#68). */
function exploreQuery(metric: CustomMetric, filter: string): string {
  switch (metric.chart) {
    case 'rate':
      return `sum(rate(${metric.name}{${filter}}[$__rate_interval]))`;
    case 'p95':
      return `histogram_quantile(0.95, sum by (le) (rate(${metric.name}_bucket{${filter}}[5m])))`;
    default:
      return `sum(${metric.name}{${filter}})`;
  }
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)};
    width: 100%;
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.5, 1)};
    cursor: pointer;
  `,
  title: css`
    margin: 0;
    font-size: ${theme.typography.body.fontSize};
  `,
  subtitle: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: ${theme.typography.bodySmall.fontSize};
    th {
      text-align: left;
      color: ${theme.colors.text.secondary};
      font-weight: ${theme.typography.fontWeightMedium};
      padding: ${theme.spacing(0.5, 1)};
      border-bottom: 1px solid ${theme.colors.border.weak};
    }
    td {
      padding: ${theme.spacing(0.75, 1)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: middle;
    }
  `,
  nameCell: css`
    max-width: 0;
    width: 60%;
  `,
  name: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    overflow-wrap: anywhere;
  `,
  unit: css`
    margin-left: ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  cardinalityHint: css`
    display: block;
    color: ${theme.colors.warning.text};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  num: css`
    text-align: right;
    white-space: nowrap;
    width: 1%;
  `,
  actions: css`
    text-align: right;
    white-space: nowrap;
    width: 1%;
  `,
  hint: css`
    padding: ${theme.spacing(0.5, 1)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
