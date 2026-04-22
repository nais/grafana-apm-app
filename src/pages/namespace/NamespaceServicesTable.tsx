import React, { useMemo } from 'react';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { ServiceSummary } from '../../api/client';
import { formatDuration } from '../../utils/format';
import { useTableSort, SortHeader, getTableStyles } from '../../components/SortableTable';
import { FrameworkBadge } from '../../components/FrameworkBadge';
import { Sparkline } from '../../components/Sparkline';

type SortField = 'name' | 'rate' | 'errorRate' | 'p95Duration';

interface NamespaceServicesTableProps {
  services: ServiceSummary[];
  sparklineMap?: Map<string, ServiceSummary>;
  onServiceClick: (namespace: string, service: string) => void;
}

export function NamespaceServicesTable({ services, sparklineMap, onServiceClick }: NamespaceServicesTableProps) {
  const tableStyles = useStyles2(getTableStyles);
  const styles = useStyles2(getLocalStyles);
  const { sortField, sortDir, toggleSort, comparator } = useTableSort<SortField>('rate');

  const sorted = useMemo(() => [...services].sort(comparator), [services, comparator]);

  return (
    <table className={tableStyles.table}>
      <colgroup>
        <col style={{ width: '30%' }} />
        <col style={{ width: '15%' }} />
        <col style={{ width: '15%' }} />
        <col style={{ width: '15%' }} />
        <col style={{ width: '25%' }} />
      </colgroup>
      <thead>
        <tr>
          <SortHeader field="name" label="Service" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          <SortHeader field="rate" label="Rate" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          <SortHeader field="errorRate" label="Error %" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          <SortHeader field="p95Duration" label="P95" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          <th style={{ textAlign: 'right' }}>Trend</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((svc) => {
          const sparkKey = `${svc.namespace}/${svc.name}/${svc.environment ?? ''}`;
          const spark = sparklineMap?.get(sparkKey);
          return (
            <tr
              key={`${svc.name}/${svc.environment ?? ''}`}
              className={tableStyles.clickableRow}
              onClick={() => onServiceClick(svc.namespace, svc.name)}
            >
              <td className={tableStyles.nameCell}>
                {svc.name}
                <FrameworkBadge framework={svc.framework} className={styles.badge} />
              </td>
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
});
