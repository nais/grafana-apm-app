import React, { useCallback, useMemo, useState } from 'react';
import { useStyles2, Icon, LoadingPlaceholder, Alert } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getServiceDependencies, DependencySummary, DependenciesResponse } from '../../api/client';
import { useAppNavigate } from '../../utils/navigation';
import { DepTypeIcon, formatDepType } from '../../components/DepTypeIcon';
import { formatDuration } from '../../utils/format';
import { useFetch } from '../../utils/useFetch';

interface DependenciesTabProps {
  service: string;
  namespace: string;
  fromMs: number;
  toMs: number;
}

export function DependenciesTab({ service, namespace, fromMs, toMs }: DependenciesTabProps) {
  const styles = useStyles2(getStyles);
  const appNavigate = useAppNavigate();
  const {
    data: depsResp,
    loading,
    error,
  } = useFetch<DependenciesResponse>(
    () => getServiceDependencies(namespace, service, fromMs, toMs),
    [service, namespace, fromMs, toMs]
  );
  const deps = useMemo(() => depsResp?.dependencies ?? [], [depsResp]);
  const [sortField, setSortField] = useState<keyof DependencySummary>('impact');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

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
      return sortDir === 'asc' ? String(aVal).localeCompare(String(bVal)) : String(bVal).localeCompare(String(aVal));
    });
  }, [deps, sortField, sortDir]);

  if (loading) {
    return <LoadingPlaceholder text="Loading dependencies..." />;
  }

  if (error) {
    return (
      <Alert severity="error" title="Error loading dependencies">
        {error}
      </Alert>
    );
  }

  if (deps.length === 0) {
    return (
      <Alert severity="info" title="No dependencies detected">
        No downstream dependencies found for {service}. Dependencies are detected from client spans in the service
        graph.
      </Alert>
    );
  }

  return (
    <div>
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
              onClick={() => appNavigate(`dependencies/${encodeURIComponent(dep.name)}`)}
            >
              <td className={styles.nameCell}>
                <DepTypeIcon type={dep.type} />
                <span style={{ marginLeft: 8 }}>{dep.name}</span>
              </td>
              <td className={styles.kindCell}>{formatDepType(dep.type)}</td>
              <td className={styles.numCell}>{dep.rate.toFixed(2)} req/s</td>
              <td className={dep.errorRate > 0 ? styles.errorCell : styles.numCell}>{dep.errorRate.toFixed(1)}%</td>
              <td className={styles.numCell}>{formatDuration(dep.p95Duration, dep.durationUnit)}</td>
              <td className={styles.numCell}>
                <ImpactBar impact={dep.impact} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

const getStyles = (theme: GrafanaTheme2) => ({
  table: css`
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    th {
      text-align: left;
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      color: ${theme.colors.text.secondary};
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      border-bottom: 1px solid ${theme.colors.border.medium};
      white-space: nowrap;
      user-select: none;
    }
    th:nth-child(n + 3) {
      text-align: right;
    }
    td {
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: middle;
    }
  `,
  clickableRow: css`
    cursor: pointer;
    &:hover {
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
  nameCell: css`
    font-weight: ${theme.typography.fontWeightMedium};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: ${theme.colors.text.link};
  `,
  kindCell: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  numCell: css`
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  `,
  errorCell: css`
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  impactBarContainer: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    min-width: 100px;
  `,
  impactBarFill: css`
    height: 8px;
    background: ${theme.colors.primary.main};
    border-radius: 4px;
    transition: width 0.3s ease;
  `,
  impactBarLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    min-width: 32px;
    text-align: right;
  `,
});
