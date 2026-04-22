import React, { useCallback, useMemo, useState } from 'react';
import { PluginPage } from '@grafana/runtime';
import { useStyles2, Icon, LoadingPlaceholder, Alert, Input, RadioButtonGroup, Select } from '@grafana/ui';
import { GrafanaTheme2, PageLayoutType, SelectableValue } from '@grafana/data';
import { css } from '@emotion/css';
import { getGlobalDependencies, DependencySummary, DependenciesResponse } from '../api/client';
import { formatDuration, formatRate, formatErrorRate } from '../utils/format';
import { useTimeRange } from '../utils/timeRange';
import { useAppNavigate, sanitizeParam } from '../utils/navigation';
import { DepTypeIcon, formatDepType } from '../components/DepTypeIcon';
import { SortHeader, ImpactBar, useTableSort, getTableStyles } from '../components/SortableTable';
import { useFetch } from '../utils/useFetch';
import { useConfiguredEnvironments } from '../utils/datasources';
import { useSearchParams } from 'react-router-dom';

function Dependencies() {
  const styles = useStyles2(getStyles);
  const appNavigate = useAppNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const envFilter = sanitizeParam(searchParams.get('environment') ?? '');
  const { fromMs, toMs } = useTimeRange();

  // Read configured environment names from plugin datasource config
  const configuredEnvs = useConfiguredEnvironments();
  const envOptions = useMemo<Array<SelectableValue<string>>>(() => {
    return configuredEnvs.map((e) => ({ label: e, value: e }));
  }, [configuredEnvs]);

  const setEnvFilter = useCallback(
    (env: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (env) {
            next.set('environment', env);
          } else {
            next.delete('environment');
          }
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const {
    data: depsResp,
    loading,
    error,
  } = useFetch<DependenciesResponse>(
    () => getGlobalDependencies(fromMs, toMs, envFilter || undefined),
    [fromMs, toMs, envFilter]
  );
  const deps = useMemo(() => depsResp?.dependencies ?? [], [depsResp]);

  const { sortField, sortDir, toggleSort, comparator } = useTableSort<keyof DependencySummary>('impact');
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
    const byCount = [...types.entries()].sort((a, b) => b[1] - a[1]);
    for (const [t, count] of byCount) {
      opts.push({ label: `${formatDepType(t)} (${count})`, value: t });
    }
    return opts;
  }, [deps]);

  // Client-side filtering and sorting — computed every render (not memoized)
  // to avoid stale-closure issues with React 18 batching.
  const searchLower = search.toLowerCase();
  const filtered = deps.filter((d) => {
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
  });
  filtered.sort(comparator);

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
            {envOptions.length > 0 && (
              <Select
                options={[{ label: 'All environments', value: '' }, ...envOptions]}
                value={envFilter}
                onChange={(v) => setEnvFilter(v?.value ?? '')}
                width={22}
                placeholder="Environment"
              />
            )}
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
            {filtered.length === 0 ? (
              <Alert severity="info" title="No matches">
                No dependencies match the current filters.
              </Alert>
            ) : (
              <>
                <div className={styles.resultCount}>
                  Showing {filtered.length} of {deps.length} dependencies
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
                    {filtered.map((dep) => (
                      <tr
                        key={`${dep.name}-${dep.type}`}
                        className={styles.clickableRow}
                        onClick={() => {
                          appNavigate(`dependencies/${encodeURIComponent(dep.name)}`);
                        }}
                      >
                        <td className={styles.nameCell} title={dep.name}>
                          <DepTypeIcon type={dep.type} />
                          <span style={{ marginLeft: 8 }}>{dep.name}</span>
                        </td>
                        <td className={styles.typeCell}>{formatDepType(dep.type)}</td>
                        <td className={styles.numCell}>{formatRate(dep.rate)}</td>
                        <td className={dep.errorRate > 0 ? styles.errorCell : styles.numCell}>
                          {formatErrorRate(dep.errorRate)}
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

const getStyles = (theme: GrafanaTheme2) => ({
  ...getTableStyles(theme),
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
  depIcon: css`
    margin-right: ${theme.spacing(0.75)};
  `,
  typeCell: css`
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
  `,
});

export default Dependencies;
