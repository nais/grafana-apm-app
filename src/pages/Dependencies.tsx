import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { useStyles2, Icon, LoadingPlaceholder, Alert } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getGlobalDependencies, DependencySummary } from '../api/client';
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

function Dependencies() {
  const styles = useStyles2(getStyles);
  const navigate = useNavigate();
  const [deps, setDeps] = useState<DependencySummary[]>([]);
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
        const resp = await getGlobalDependencies(now - 3600000, now);
        setDeps(resp.dependencies);
      } catch (e: any) {
        setError(e.message ?? 'Failed to load dependencies');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

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
    return [...deps].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      return sortDir === 'asc'
        ? String(aVal).localeCompare(String(bVal))
        : String(bVal).localeCompare(String(aVal));
    });
  }, [deps, sortField, sortDir]);

  return (
    <PluginPage>
      <div className={styles.container}>
        <p className={styles.description}>
          External dependencies detected from service graph edges. Shows databases, caches, message brokers, and
          other services called by your applications.
        </p>

        {loading && <LoadingPlaceholder text="Loading dependencies..." />}

        {error && (
          <Alert severity="error" title="Error loading dependencies">
            {error}
          </Alert>
        )}

        {!loading && !error && deps.length === 0 && (
          <Alert severity="info" title="No dependencies detected">
            No external dependencies found. Make sure the OTel Collector&apos;s servicegraph connector is configured
            with <code>virtual_node_peer_attributes</code>.
          </Alert>
        )}

        {!loading && !error && deps.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <SortHeader field="name" label="Dependency" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader field="type" label="Type" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader field="rate" label="Throughput" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader field="errorRate" label="Error %" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader
                  field="p95Duration"
                  label="Latency (P95)"
                  sortField={sortField}
                  sortDir={sortDir}
                  onSort={toggleSort}
                />
                <SortHeader field="impact" label="Impact" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((dep) => (
                <tr
                  key={dep.name}
                  className={styles.clickableRow}
                  onClick={() => navigate(`${PLUGIN_BASE_URL}/dependencies/${encodeURIComponent(dep.name)}`)}
                >
                  <td className={styles.nameCell}>
                    <span className={styles.depIcon}>{DEP_TYPE_ICONS[dep.type] ?? '❓'}</span>
                    {dep.name}
                  </td>
                  <td className={styles.typeCell}>{dep.type}</td>
                  <td className={styles.numCell}>{dep.rate.toFixed(2)} req/s</td>
                  <td className={dep.errorRate > 0 ? styles.errorCell : styles.numCell}>
                    {dep.errorRate.toFixed(1)}%
                  </td>
                  <td className={styles.numCell}>{formatDuration(dep.p95Duration, dep.durationUnit)}</td>
                  <td className={styles.numCell}>
                    <ImpactBar impact={dep.impact} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
  description: css`
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
  `,
  depIcon: css`
    margin-right: ${theme.spacing(0.75)};
  `,
  typeCell: css`
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
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

export default Dependencies;
