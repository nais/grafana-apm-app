import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { useStyles2, Icon, LoadingPlaceholder, Alert, LinkButton } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getDependencyDetail, DependencySummary, DependencyDetailResponse, OperationSummary } from '../api/client';
import { PLUGIN_BASE_URL } from '../constants';

const DEP_TYPE_ICONS: Record<string, string> = {
  redis: '🔴',
  postgresql: '🐘',
  mysql: '🐬',
  mongodb: '🍃',
  kafka: '📨',
  rabbitmq: '🐇',
  elasticsearch: '🔍',
  memcached: '⚡',
  external: '🌐',
  service: '🔷',
};

function DependencyDetail() {
  const { name = '' } = useParams<{ name: string }>();
  const styles = useStyles2(getStyles);
  const navigate = useNavigate();
  const [data, setData] = useState<DependencyDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<keyof DependencySummary>('impact');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const now = Date.now();
        const resp = await getDependencyDetail(name, now - 3600000, now);
        setData(resp);
      } catch (e: any) {
        setError(e.message ?? 'Failed to load dependency details');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [name]);

  const toggleSort = useCallback((field: keyof DependencySummary) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir('desc');
      return field;
    });
  }, []);

  const sorted = useMemo(() => {
    if (!data) {
      return [];
    }
    return [...data.upstreams].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      return sortDir === 'asc'
        ? String(aVal).localeCompare(String(bVal))
        : String(bVal).localeCompare(String(aVal));
    });
  }, [data, sortField, sortDir]);

  return (
    <PluginPage>
      <div className={styles.container}>
        <div className={styles.header}>
          <LinkButton
            variant="secondary"
            size="sm"
            icon="arrow-left"
            onClick={() => navigate(`${PLUGIN_BASE_URL}/dependencies`)}
          >
            Back to Dependencies
          </LinkButton>
        </div>

        {loading && <LoadingPlaceholder text="Loading dependency details..." />}

        {error && (
          <Alert severity="error" title="Error">
            {error}
          </Alert>
        )}

        {!loading && !error && data && (
          <>
            {/* Summary card */}
            <div className={styles.summaryCard}>
              <div className={styles.summaryTitle}>
                <span className={styles.depIcon}>
                  {DEP_TYPE_ICONS[data.dependency.type] ?? '❓'}
                </span>
                <h2 className={styles.depName}>{name}</h2>
                <span className={styles.typeBadge}>{data.dependency.type}</span>
              </div>
              <div className={styles.summaryStats}>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Throughput</span>
                  <span className={styles.statValue}>{data.dependency.rate.toFixed(2)} req/s</span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Error Rate</span>
                  <span
                    className={
                      data.dependency.errorRate > 0
                        ? styles.statValueError
                        : styles.statValue
                    }
                  >
                    {data.dependency.errorRate.toFixed(1)}%
                  </span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Latency (P95)</span>
                  <span className={styles.statValue}>
                    {formatDuration(data.dependency.p95Duration, data.dependency.durationUnit)}
                  </span>
                </div>
              </div>
            </div>

            {/* Upstream services */}
            <h3 className={styles.sectionTitle}>Upstream Services</h3>
            <p className={styles.sectionDesc}>
              Services that call this dependency, ranked by impact.
            </p>

            {sorted.length === 0 ? (
              <Alert severity="info" title="No upstream data">
                No upstream services found for this dependency.
              </Alert>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <SortHeader
                      field="name"
                      label="Service"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortHeader
                      field="rate"
                      label="Throughput"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortHeader
                      field="errorRate"
                      label="Error %"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortHeader
                      field="p95Duration"
                      label="Latency (P95)"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortHeader
                      field="impact"
                      label="Impact"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((upstream) => (
                    <tr
                      key={upstream.name}
                      className={styles.clickableRow}
                      onClick={() => navigate(`${PLUGIN_BASE_URL}/services`)}
                    >
                      <td className={styles.nameCell}>
                        <Icon name="gf-layout-simple" size="sm" />
                        <span style={{ marginLeft: 8 }}>{upstream.name}</span>
                      </td>
                      <td className={styles.numCell}>{upstream.rate.toFixed(2)} req/s</td>
                      <td className={upstream.errorRate > 0 ? styles.errorCell : styles.numCell}>
                        {upstream.errorRate.toFixed(1)}%
                      </td>
                      <td className={styles.numCell}>
                        {formatDuration(upstream.p95Duration, upstream.durationUnit)}
                      </td>
                      <td className={styles.numCell}>
                        <ImpactBar impact={upstream.impact} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Operations calling this dependency */}
            {data.operations && data.operations.length > 0 && (
              <>
                <h3 className={styles.sectionTitle}>Operations</h3>
                <p className={styles.sectionDesc}>
                  Client-side operations that call this dependency (from spanmetrics <code>peer.service</code> dimension).
                </p>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Operation</th>
                      <th>Calling Service</th>
                      <th>Throughput</th>
                      <th>Error %</th>
                      <th>Latency (P95)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.operations.map((op: OperationSummary, idx: number) => (
                      <tr key={`${op.spanName}-${op.spanKind}-${idx}`}>
                        <td className={styles.nameCell}>{op.spanName}</td>
                        <td>{op.spanKind}</td>
                        <td className={styles.numCell}>{op.rate.toFixed(2)} req/s</td>
                        <td className={op.errorRate > 0 ? styles.errorCell : styles.numCell}>
                          {op.errorRate.toFixed(1)}%
                        </td>
                        <td className={styles.numCell}>
                          {formatDuration(op.p95Duration, op.durationUnit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>
    </PluginPage>
  );
}

function SortHeader({
  field,
  label,
  sortField,
  sortDir,
  onSort,
}: {
  field: keyof DependencySummary;
  label: string;
  sortField: keyof DependencySummary;
  sortDir: 'asc' | 'desc';
  onSort: (f: keyof DependencySummary) => void;
}) {
  const styles = useStyles2(getStyles);
  return (
    <th className={styles.sortableHeader} onClick={() => onSort(field)}>
      {label} {sortField === field && <Icon name={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'} size="sm" />}
    </th>
  );
}

function ImpactBar({ impact }: { impact: number }) {
  const styles = useStyles2(getStyles);
  const pct = Math.round(impact * 100);
  return (
    <div className={styles.impactBarContainer}>
      <div className={styles.impactBarFill} style={{ width: `${pct}%` }} />
      <span className={styles.impactBarLabel}>{pct}%</span>
    </div>
  );
}

function formatDuration(value: number, unit: string): string {
  if (unit === 'ms') {
    if (value < 1) {
      return '< 1ms';
    }
    if (value >= 1000) {
      return `${(value / 1000).toFixed(1)}s`;
    }
    return `${Math.round(value)}ms`;
  }
  if (value < 0.001) {
    return '< 1ms';
  }
  if (value < 1) {
    return `${Math.round(value * 1000)}ms`;
  }
  return `${value.toFixed(1)}s`;
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    padding: ${theme.spacing(1)} ${theme.spacing(2)};
  `,
  header: css`
    margin-bottom: ${theme.spacing(2)};
  `,
  summaryCard: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)} ${theme.spacing(3)};
    margin-bottom: ${theme.spacing(3)};
  `,
  summaryTitle: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(2)};
  `,
  depIcon: css`
    font-size: 24px;
  `,
  depName: css`
    margin: 0;
    font-size: ${theme.typography.h2.fontSize};
  `,
  typeBadge: css`
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    background: ${theme.colors.background.canvas};
    border: 1px solid ${theme.colors.border.medium};
  `,
  summaryStats: css`
    display: flex;
    gap: ${theme.spacing(4)};
  `,
  statItem: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
  `,
  statLabel: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  statValue: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
  `,
  statValueError: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.error.text};
  `,
  sectionTitle: css`
    margin-top: ${theme.spacing(2)};
    margin-bottom: ${theme.spacing(0.5)};
    font-size: ${theme.typography.h4.fontSize};
  `,
  sectionDesc: css`
    color: ${theme.colors.text.secondary};
    margin-bottom: ${theme.spacing(2)};
  `,
  table: css`
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    th {
      text-align: left;
      padding: ${theme.spacing(1)} ${theme.spacing(2)};
      color: ${theme.colors.text.secondary};
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      border-bottom: 1px solid ${theme.colors.border.medium};
      white-space: nowrap;
    }
    td {
      padding: ${theme.spacing(1)} ${theme.spacing(2)};
      border-bottom: 1px solid ${theme.colors.border.weak};
    }
    tr:hover {
      background: ${theme.colors.background.secondary};
    }
  `,
  sortableHeader: css`
    cursor: pointer;
    user-select: none;
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
  clickableRow: css`
    cursor: pointer;
  `,
  nameCell: css`
    font-weight: ${theme.typography.fontWeightMedium};
    white-space: nowrap;
    display: flex;
    align-items: center;
  `,
  numCell: css`
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  `,
  errorCell: css`
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  impactBarContainer: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    min-width: 120px;
  `,
  impactBarFill: css`
    height: 8px;
    background: ${theme.colors.primary.main};
    border-radius: 4px;
    min-width: 2px;
    flex-shrink: 0;
  `,
  impactBarLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: ${theme.colors.text.secondary};
  `,
});

export default DependencyDetail;
