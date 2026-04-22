import React, { useMemo } from 'react';
import { useStyles2, LoadingPlaceholder, Alert } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getServiceDependencies, DependencySummary, DependenciesResponse } from '../../api/client';
import { useAppNavigate } from '../../utils/navigation';
import { DepTypeIcon, formatDepType } from '../../components/DepTypeIcon';
import { formatDuration, formatRate, formatErrorRate } from '../../utils/format';
import { SortHeader, ImpactBar, useTableSort, getTableStyles } from '../../components/SortableTable';
import { useFetch } from '../../utils/useFetch';

interface DependenciesTabProps {
  service: string;
  namespace: string;
  fromMs: number;
  toMs: number;
  environment?: string;
}

export function DependenciesTab({ service, namespace, fromMs, toMs, environment }: DependenciesTabProps) {
  const styles = useStyles2(getStyles);
  const appNavigate = useAppNavigate();
  const {
    data: depsResp,
    loading,
    error,
  } = useFetch<DependenciesResponse>(
    () => getServiceDependencies(namespace, service, fromMs, toMs, environment),
    [service, namespace, fromMs, toMs, environment]
  );
  const deps = useMemo(() => depsResp?.dependencies ?? [], [depsResp]);
  const { sortField, sortDir, toggleSort, comparator } = useTableSort<keyof DependencySummary>('impact');

  const sorted = useMemo(() => {
    return [...deps].sort(comparator);
  }, [deps, comparator]);

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
              onClick={() => {
                appNavigate(`dependencies/${encodeURIComponent(dep.name)}`);
              }}
            >
              <td className={styles.nameCell} title={dep.name}>
                <DepTypeIcon type={dep.type} />
                <span style={{ marginLeft: 8 }}>{dep.name}</span>
              </td>
              <td className={styles.kindCell}>{formatDepType(dep.type)}</td>
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
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  ...getTableStyles(theme),
  kindCell: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
