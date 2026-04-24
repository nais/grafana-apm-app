import React, { useMemo } from 'react';
import { Pagination, useStyles2 } from '@grafana/ui';
import { NamespaceDependency } from '../../api/client';
import { useTableSort, SortHeader, getTableStyles } from '../../components/SortableTable';
import { getSectionStyles } from '../../utils/styles';
import { DepTypeIcon } from '../../components/DepTypeIcon';
import { getDependencyHealth } from '../../utils/health';
import { HealthIndicator } from '../../components/HealthIndicator';

const PAGE_SIZE = 10;

interface NamespaceDependenciesProps {
  dependencies: NamespaceDependency[];
  page: number;
  onPageChange: (p: number) => void;
}

type SortField = 'name' | 'callerCount' | 'rate' | 'errorRate' | 'p95Duration';

export function NamespaceDependencies({ dependencies, page, onPageChange }: NamespaceDependenciesProps) {
  const tableStyles = useStyles2(getTableStyles);
  const sectionStyles = useStyles2(getSectionStyles);
  const { sortField, sortDir, toggleSort, comparator } = useTableSort<SortField>('rate');

  const sorted = useMemo(() => [...dependencies].sort(comparator), [dependencies, comparator]);

  if (sorted.length === 0) {
    return null;
  }

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className={sectionStyles.section}>
      <h3 className={sectionStyles.sectionTitle}>External Dependencies</h3>
      <p className={sectionStyles.sectionSubtitle}>
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
          {paginated.map((dep) => (
            <tr key={dep.name}>
              <td className={tableStyles.nameCell} title={dep.name}>
                <HealthIndicator status={getDependencyHealth(dep.errorRate)} /> {dep.displayName || dep.name}
              </td>
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
      {totalPages > 1 && <Pagination currentPage={safePage} numberOfPages={totalPages} onNavigate={onPageChange} />}
    </div>
  );
}
