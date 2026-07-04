import React, { useMemo } from 'react';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { EndpointSummary } from '../../../api/client';
import { formatDuration, formatRate, formatErrorRate } from '../../../utils/format';
import { SortHeader, useTableSort, getTableStyles } from '../../../components/SortableTable';
import { DepTypeIcon } from '../../../components/DepTypeIcon';

type SortField = 'dbSystem' | 'spanName' | 'rate' | 'errorRate' | 'p50Duration' | 'p95Duration' | 'p99Duration';

interface QueryOperationsTableProps {
  operations: EndpointSummary[];
  durationUnit: string;
  onViewTraces?: (spanName: string, status?: string) => void;
}

/**
 * Sortable snapshot table of database operations for the current time window
 * — the same `endpoints.database` data ServerTab's "Database Operations"
 * section shows, elevated here as the primary query-analytics view. Backed
 * by span-metrics aggregation already computed by the backend
 * (GET /services/:ns/:service/endpoints), so accuracy/availability matches
 * what ServerTab already ships in production.
 */
export function QueryOperationsTable({ operations, durationUnit, onViewTraces }: QueryOperationsTableProps) {
  const styles = useStyles2(getStyles);
  const { sortField, sortDir, toggleSort, comparator } = useTableSort<SortField>('rate', 'desc', 'dbOps');

  const sorted = useMemo(() => [...operations].sort(comparator), [operations, comparator]);

  return (
    <table className={styles.table}>
      <colgroup>
        <col style={{ width: '16%' }} />
        <col style={{ width: 'auto' }} />
        <col style={{ width: '13%' }} />
        <col style={{ width: '13%' }} />
        <col style={{ width: '12%' }} />
        <col style={{ width: '12%' }} />
        <col style={{ width: '12%' }} />
      </colgroup>
      <thead>
        <tr>
          <SortHeader field="dbSystem" label="System" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          <SortHeader field="spanName" label="Operation" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          <SortHeader field="rate" label="Rate" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          <SortHeader field="errorRate" label="Error %" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          <SortHeader field="p50Duration" label="P50" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          <SortHeader field="p95Duration" label="P95" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          <SortHeader field="p99Duration" label="P99" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
        </tr>
      </thead>
      <tbody>
        {sorted.map((op) => {
          const clickable = !!onViewTraces && !!op.spanName;
          return (
            <tr
              key={op.spanName}
              className={clickable ? styles.clickableRow : undefined}
              onClick={clickable ? () => onViewTraces!(op.spanName, op.errorRate > 0 ? 'error' : '') : undefined}
              title={clickable ? `View traces for ${op.spanName}` : undefined}
            >
              <td>
                {op.dbSystem ? (
                  <span className={styles.systemCell}>
                    <DepTypeIcon type={op.dbSystem} size={18} />
                    <span>{op.dbSystem}</span>
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td className={styles.nameCell} title={op.spanName}>
                {op.spanName}
              </td>
              <td className={styles.numCell}>{formatRate(op.rate)}</td>
              <td className={op.errorRate > 0 ? styles.errorCell : styles.numCell}>{formatErrorRate(op.errorRate)}</td>
              <td className={styles.numCell}>{formatDuration(op.p50Duration, durationUnit)}</td>
              <td className={styles.numCell}>{formatDuration(op.p95Duration, durationUnit)}</td>
              <td className={styles.numCell}>{formatDuration(op.p99Duration, durationUnit)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  ...getTableStyles(theme),
  systemCell: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    text-transform: capitalize;
  `,
});
