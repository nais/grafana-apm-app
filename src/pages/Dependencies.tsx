import React, { useCallback, useMemo, useState } from 'react';
import { PluginPage } from '@grafana/runtime';
import { useStyles2, Icon, LoadingPlaceholder, Alert, Input, RadioButtonGroup } from '@grafana/ui';
import { GrafanaTheme2, PageLayoutType } from '@grafana/data';
import { css } from '@emotion/css';
import { getGlobalDependencies, DependencySummary, DependenciesResponse } from '../api/client';
import { formatDuration } from '../utils/format';
import { useTimeRange } from '../utils/timeRange';
import { useAppNavigate } from '../utils/navigation';
import { DepTypeIcon, formatDepType } from '../components/DepTypeIcon';
import { useFetch } from '../utils/useFetch';

function Dependencies() {
  const styles = useStyles2(getStyles);
  const appNavigate = useAppNavigate();
  const { fromMs, toMs } = useTimeRange();
  const {
    data: depsResp,
    loading,
    error,
  } = useFetch<DependenciesResponse>(() => getGlobalDependencies(fromMs, toMs), [fromMs, toMs]);
  const deps = useMemo(() => depsResp?.dependencies ?? [], [depsResp]);
  const [sortField, setSortField] = useState<keyof DependencySummary>('impact');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [errorsOnly, setErrorsOnly] = useState(false);

  // Derive unique types from data for the filter chips
  const typeOptions = useMemo(() => {
    const types = new Map<string, number>();
    for (const d of deps) {
      types.set(d.type, (types.get(d.type) ?? 0) + 1);
    }
    const opts: Array<{ label: string; value: string }> = [{ label: `All (${deps.length})`, value: 'all' }];
    const sorted = [...types.entries()].sort((a, b) => b[1] - a[1]);
    for (const [t, count] of sorted) {
      opts.push({ label: `${formatDepType(t)} (${count})`, value: t });
    }
    return opts;
  }, [deps]);

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
    const searchLower = search.toLowerCase();
    return [...deps]
      .filter((d) => {
        if (searchLower && !d.name.toLowerCase().includes(searchLower)) {
          return false;
        }
        if (typeFilter !== 'all' && d.type !== typeFilter) {
          return false;
        }
        if (errorsOnly && d.errorRate <= 0) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aVal = a[sortField];
        const bVal = b[sortField];
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
        }
        return sortDir === 'asc' ? String(aVal).localeCompare(String(bVal)) : String(bVal).localeCompare(String(aVal));
      });
  }, [deps, sortField, sortDir, search, typeFilter, errorsOnly]);

  return (
    <PluginPage layout={PageLayoutType.Canvas}>
      <div className={styles.container}>
        <p className={styles.description}>
          External dependencies detected from service graph edges. Shows databases, caches, message brokers, and other
          services called by your applications.
        </p>

        {!loading && !error && deps.length > 0 && (
          <div className={styles.filters}>
            <Input
              prefix={<Icon name="search" />}
              placeholder="Search dependencies..."
              width={28}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
            />
            <RadioButtonGroup
              options={typeOptions}
              value={typeFilter}
              onChange={(v) => setTypeFilter(v ?? 'all')}
              size="sm"
            />
            <label className={styles.checkboxLabel}>
              <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
              With errors only
            </label>
          </div>
        )}

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
          <>
            {sorted.length === 0 ? (
              <Alert severity="info" title="No matches">
                No dependencies match the current filters.
              </Alert>
            ) : (
              <>
                <div className={styles.resultCount}>
                  Showing {sorted.length} of {deps.length} dependencies
                </div>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <SortHeader
                        field="name"
                        label="Dependency"
                        sortField={sortField}
                        sortDir={sortDir}
                        onSort={toggleSort}
                      />
                      <SortHeader
                        field="type"
                        label="Type"
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
                        <td className={styles.typeCell}>{formatDepType(dep.type)}</td>
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

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    padding: 0;
  `,
  description: css`
    color: ${theme.colors.text.secondary};
    margin-bottom: ${theme.spacing(2)};
  `,
  filters: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    margin-bottom: ${theme.spacing(2)};
    flex-wrap: wrap;
  `,
  checkboxLabel: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
    input {
      cursor: pointer;
    }
  `,
  resultCount: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin-bottom: ${theme.spacing(1)};
  `,
  table: css`
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    table-layout: fixed;
    th:nth-child(1) {
      width: 28%;
    }
    th:nth-child(2) {
      width: 10%;
    }
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
      width: auto;
      text-align: right;
    }
    td {
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: middle;
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
    color: ${theme.colors.text.link};
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
