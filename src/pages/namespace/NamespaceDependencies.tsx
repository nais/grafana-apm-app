import React, { useMemo } from 'react';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { NamespaceDependency } from '../../api/client';
import { useTableSort, SortHeader, getTableStyles } from '../../components/SortableTable';
import { DepTypeIcon } from '../../components/DepTypeIcon';

interface NamespaceDependenciesProps {
  dependencies: NamespaceDependency[];
}

type SortField = 'name' | 'callerCount' | 'rate' | 'errorRate' | 'p95Duration';

export function NamespaceDependencies({ dependencies }: NamespaceDependenciesProps) {
  const tableStyles = useStyles2(getTableStyles);
  const styles = useStyles2(getLocalStyles);
  const { sortField, sortDir, toggleSort, comparator } = useTableSort<SortField>('rate');

  const sorted = useMemo(() => [...dependencies].sort(comparator), [dependencies, comparator]);

  if (sorted.length === 0) {
    return null;
  }

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>External Dependencies</h3>
      <p className={styles.sectionSubtitle}>
        Services and resources outside this namespace that are called by namespace services.
      </p>
      <table className={tableStyles.table}>
        <colgroup>
          <col style={{ width: '25%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '13%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '20%' }} />
        </colgroup>
        <thead>
          <tr>
            <SortHeader field="name" label="Dependency" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <th>Type</th>
            <SortHeader
              field="callerCount"
              label="Callers"
              sortField={sortField}
              sortDir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader field="rate" label="Rate" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader field="errorRate" label="Error %" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader field="p95Duration" label="P95" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((dep) => (
            <tr key={dep.name}>
              <td className={tableStyles.nameCell}>{dep.name}</td>
              <td>
                <DepTypeIcon type={dep.type} />
              </td>
              <td className={tableStyles.numCell}>
                {dep.callerCount} {dep.callerCount === 1 ? 'service' : 'services'}
              </td>
              <td className={tableStyles.numCell}>{dep.rate.toFixed(2)} req/s</td>
              <td className={tableStyles.numCell}>{(dep.errorRate * 100).toFixed(1)}%</td>
              <td className={tableStyles.numCell}>{dep.p95Duration > 0 ? `${dep.p95Duration.toFixed(0)}ms` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const getLocalStyles = (theme: GrafanaTheme2) => ({
  section: css`
    margin-top: ${theme.spacing(3)};
  `,
  sectionTitle: css`
    margin-bottom: ${theme.spacing(0.5)};
    font-size: ${theme.typography.h4.fontSize};
  `,
  sectionSubtitle: css`
    margin: 0 0 ${theme.spacing(1.5)} 0;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
