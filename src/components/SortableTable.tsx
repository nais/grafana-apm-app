import React, { useCallback, useMemo, useState } from 'react';
import { useStyles2, Icon } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';

// --- useTableSort hook ---

interface TableSortState<F extends string> {
  sortField: F;
  sortDir: 'asc' | 'desc';
  toggleSort: (field: F) => void;
  comparator: <R extends Record<F, string | number>>(a: R, b: R) => number;
}

export function useTableSort<F extends string>(
  initialField: F,
  initialDir: 'asc' | 'desc' = 'desc'
): TableSortState<F> {
  const [sortField, setSortField] = useState<F>(initialField);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(initialDir);

  const toggleSort = useCallback((field: F) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir('desc');
      return field;
    });
  }, []);

  const comparator = useMemo(() => {
    return <R extends Record<F, string | number>>(a: R, b: R): number => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      return sortDir === 'asc' ? String(aVal).localeCompare(String(bVal)) : String(bVal).localeCompare(String(aVal));
    };
  }, [sortField, sortDir]);

  return { sortField, sortDir, toggleSort, comparator };
}

// --- SortHeader component ---

interface SortHeaderProps<F extends string> {
  field: F;
  label: string;
  sortField: F;
  sortDir: 'asc' | 'desc';
  onSort: (f: F) => void;
}

export function SortHeader<F extends string>({ field, label, sortField, sortDir, onSort }: SortHeaderProps<F>) {
  const styles = useStyles2(getTableStyles);
  return (
    <th className={styles.sortableHeader} onClick={() => onSort(field)}>
      {label} {sortField === field && <Icon name={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'} size="sm" />}
    </th>
  );
}

// --- ImpactBar component ---

export function ImpactBar({ impact }: { impact: number }) {
  const styles = useStyles2(getTableStyles);
  const pct = Math.round(impact * 100);
  return (
    <div className={styles.impactBarContainer}>
      <div className={styles.impactBarTrack}>
        <div className={styles.impactBarFill} style={{ width: `${pct}%` }} />
      </div>
      <span className={styles.impactBarLabel}>{pct}%</span>
    </div>
  );
}

// --- Shared table styles ---

export const getTableStyles = (theme: GrafanaTheme2) => ({
  table: css`
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    table-layout: fixed;
    th {
      text-align: left;
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      color: ${theme.colors.text.secondary};
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      border-bottom: 1px solid ${theme.colors.border.medium};
      white-space: nowrap;
      user-select: none;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    th:nth-child(n + 3) {
      text-align: right;
    }
    td {
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: middle;
      overflow: hidden;
      text-overflow: ellipsis;
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
    &:hover {
      background: ${theme.colors.background.secondary};
    }
  `,
  nameCell: css`
    font-weight: ${theme.typography.fontWeightMedium};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: ${theme.colors.text.link};
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
    justify-content: flex-end;
    gap: ${theme.spacing(1)};
  `,
  impactBarTrack: css`
    width: 60px;
    height: 8px;
    background: ${theme.colors.background.canvas};
    border-radius: 4px;
    overflow: hidden;
  `,
  impactBarFill: css`
    height: 100%;
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
