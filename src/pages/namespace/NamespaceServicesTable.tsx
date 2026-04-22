import React, { useMemo } from 'react';
import { Icon, Input, Pagination, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { ServiceSummary } from '../../api/client';
import { formatDuration } from '../../utils/format';
import { useTableSort, SortHeader, getTableStyles } from '../../components/SortableTable';
import { FrameworkBadge } from '../../components/FrameworkBadge';
import { Sparkline } from '../../components/Sparkline';

const PAGE_SIZE = 10;

type SortField = 'name' | 'rate' | 'errorRate' | 'p95Duration';

interface NamespaceServicesTableProps {
  services: ServiceSummary[];
  sparklineMap?: Map<string, ServiceSummary>;
  showEnvironment?: boolean;
  search: string;
  page: number;
  onSearchChange: (q: string) => void;
  onPageChange: (p: number) => void;
  onServiceClick: (namespace: string, service: string, environment?: string) => void;
}

export function NamespaceServicesTable({
  services,
  sparklineMap,
  showEnvironment,
  search,
  page,
  onSearchChange,
  onPageChange,
  onServiceClick,
}: NamespaceServicesTableProps) {
  const tableStyles = useStyles2(getTableStyles);
  const styles = useStyles2(getLocalStyles);
  const { sortField, sortDir, toggleSort, comparator } = useTableSort<SortField>('rate');

  const filtered = useMemo(() => {
    let result = services;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((s) => s.name.toLowerCase().includes(q));
    }
    return [...result].sort(comparator);
  }, [services, search, comparator]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div>
      <div className={styles.toolbar}>
        <Input
          prefix={<Icon name="search" />}
          placeholder="Filter services…"
          value={search}
          onChange={(e) => {
            onSearchChange(e.currentTarget.value);
            onPageChange(1);
          }}
          width={28}
        />
        <span className={styles.count}>
          {filtered.length} {filtered.length === 1 ? 'service' : 'services'}
        </span>
      </div>
      <table className={tableStyles.table}>
        <colgroup>
          <col style={{ width: showEnvironment ? '25%' : '30%' }} />
          {showEnvironment && <col style={{ width: '15%' }} />}
          <col style={{ width: '15%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: showEnvironment ? '15%' : '25%' }} />
        </colgroup>
        <thead>
          <tr>
            <SortHeader field="name" label="Service" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            {showEnvironment && <th>Environment</th>}
            <SortHeader field="rate" label="Rate" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader field="errorRate" label="Error %" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader field="p95Duration" label="P95" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <th style={{ textAlign: 'right' }}>Trend</th>
          </tr>
        </thead>
        <tbody>
          {paginated.map((svc) => {
            const sparkKey = `${svc.namespace}/${svc.name}/${svc.environment ?? ''}`;
            const spark = sparklineMap?.get(sparkKey);
            return (
              <tr
                key={`${svc.name}/${svc.environment ?? ''}`}
                className={tableStyles.clickableRow}
                onClick={() => onServiceClick(svc.namespace, svc.name, svc.environment)}
              >
                <td className={tableStyles.nameCell}>
                  {svc.name}
                  <FrameworkBadge framework={svc.framework} className={styles.badge} />
                </td>
                {showEnvironment && <td className={tableStyles.numCell}>{svc.environment ?? '—'}</td>}
                <td className={tableStyles.numCell}>{svc.rate.toFixed(2)} req/s</td>
                <td className={svc.errorRate > 0 ? tableStyles.errorCell : tableStyles.numCell}>
                  {svc.errorRate.toFixed(2)}%
                </td>
                <td className={tableStyles.numCell}>{formatDuration(svc.p95Duration, svc.durationUnit)}</td>
                <td style={{ textAlign: 'right' }}>
                  <div className={styles.sparkContainer}>
                    <Sparkline data={spark?.durationSeries?.map((p) => p.v)} color="#FF9830" width={60} height={20} />
                    <Sparkline data={spark?.rateSeries?.map((p) => p.v)} color="#73BF69" width={60} height={20} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {totalPages > 1 && <Pagination currentPage={safePage} numberOfPages={totalPages} onNavigate={onPageChange} />}
    </div>
  );
}

const getLocalStyles = (theme: GrafanaTheme2) => ({
  badge: css`
    margin-left: ${theme.spacing(0.75)};
    vertical-align: middle;
  `,
  sparkContainer: css`
    display: flex;
    gap: ${theme.spacing(0.5)};
    justify-content: flex-end;
  `,
  toolbar: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(1)};
  `,
  count: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
