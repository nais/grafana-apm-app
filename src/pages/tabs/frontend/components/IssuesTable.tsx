import React, { useState } from 'react';
import { Badge, Pagination, Tooltip, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getExceptionGroups, ExceptionGroup } from '../../../../api/client';
import { useFetch } from '../../../../utils/useFetch';
import { useTimeRange } from '../../../../utils/timeRange';
import { useUrlParams } from '../../../../utils/useUrlState';
import { DataState } from '../../../../components/DataState';

interface IssuesTableProps {
  namespace: string;
  service: string;
  environment?: string;
}

/**
 * Fingerprint-grouped exception list (#62 Phase 0). Replaces the raw
 * per-Alloy-hash "Top Exceptions" Loki panel: the backend merges hash groups
 * whose messages differ only by dynamic content (ids, urls, timestamps), so
 * one logical error is one row. Clicking a row opens the ExceptionDrawer via
 * the issueId URL param; legacy exceptionHash links still resolve.
 */
export function IssuesTable({ namespace, service, environment }: IssuesTableProps) {
  const styles = useStyles2(getStyles);
  const { fromMs, toMs } = useTimeRange();
  const updateParams = useUrlParams();

  const { data, loading, error } = useFetch(
    () => getExceptionGroups(namespace, service, fromMs, toMs, environment),
    [namespace, service, fromMs, toMs, environment]
  );

  const groups = data?.groups ?? [];
  const totalCount = groups.reduce((sum, g) => sum + g.count, 0);

  // Client-side pagination: noisy apps produce hundreds of groups and the
  // panel would otherwise grow unbounded. The page is clamped at render so a
  // shrinking result set (time range/service change) snaps back without any
  // state juggling. The share bar stays relative to the WHOLE result set.
  const [rawPage, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const page = Math.min(rawPage, totalPages);
  const pageGroups = groups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h6 className={styles.title}>Top Exceptions</h6>
        <span className={styles.subtitle}>Grouped by stable fingerprint — one row per logical error</span>
      </div>
      <DataState
        loading={loading}
        error={error ? 'Failed to load exception groups' : data?.unavailable ? 'Loki is not available' : null}
        empty={groups.length === 0}
        loadingText="Loading exceptions…"
        emptyTitle="No exceptions"
        emptyMessage="No frontend exceptions in the selected time range."
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Error</th>
              <th className={styles.shareCol}>Share</th>
              <th className={styles.num}>Occurrences</th>
              <th className={styles.num}>Sessions</th>
            </tr>
          </thead>
          <tbody>
            {pageGroups.map((g) => (
              <IssueRow
                key={g.fingerprint}
                group={g}
                totalCount={totalCount}
                onOpen={() => updateParams({ issueId: g.fingerprint })}
              />
            ))}
          </tbody>
        </table>
        <div className={styles.footer}>
          <span className={styles.footerCount}>
            {groups.length === 1 ? '1 issue' : `${groups.length} issues`}
            {totalPages > 1 && ` · showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, groups.length)}`}
          </span>
          <Pagination currentPage={page} numberOfPages={totalPages} onNavigate={setPage} hideWhenSinglePage />
        </div>
      </DataState>
    </div>
  );
}

const PAGE_SIZE = 10;

function IssueRow({ group, totalCount, onOpen }: { group: ExceptionGroup; totalCount: number; onOpen: () => void }) {
  const styles = useStyles2(getStyles);
  const share = totalCount > 0 ? group.count / totalCount : 0;
  return (
    <tr
      className={styles.row}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
    >
      <td className={styles.errorCell}>
        <span className={styles.errorTitle}>{group.title}</span>
        {group.memberHashes.length > 1 && (
          <Tooltip
            content={`Merged from ${group.memberHashes.length} raw exception hashes whose messages differ only by dynamic content (ids, urls, timestamps).`}
          >
            <Badge className={styles.badge} text={`merged ×${group.memberHashes.length}`} color="purple" />
          </Tooltip>
        )}
      </td>
      <td className={styles.shareCol}>
        <div className={styles.shareBar}>
          <div className={styles.shareFill} style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} />
        </div>
        <span className={styles.shareLabel}>{Math.round(share * 100)}%</span>
      </td>
      <td className={styles.num}>{Math.round(group.count)}</td>
      <td className={styles.num}>{Math.round(group.sessions)}</td>
    </tr>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)};
    width: 100%;
    height: 100%;
    overflow: auto;
  `,
  header: css`
    display: flex;
    align-items: baseline;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.5, 1)};
  `,
  title: css`
    margin: 0;
    font-size: ${theme.typography.body.fontSize};
  `,
  subtitle: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: ${theme.typography.bodySmall.fontSize};
    th {
      text-align: left;
      color: ${theme.colors.text.secondary};
      font-weight: ${theme.typography.fontWeightMedium};
      padding: ${theme.spacing(0.5, 1)};
      border-bottom: 1px solid ${theme.colors.border.weak};
    }
    td {
      padding: ${theme.spacing(0.75, 1)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: top;
    }
  `,
  row: css`
    cursor: pointer;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  errorCell: css`
    max-width: 0;
    width: 100%;
  `,
  errorTitle: css`
    color: ${theme.colors.text.link};
    word-break: break-word;
  `,
  badge: css`
    margin-left: ${theme.spacing(1)};
  `,
  num: css`
    text-align: right;
    white-space: nowrap;
    width: 1%;
  `,
  shareCol: css`
    white-space: nowrap;
    width: 140px;
  `,
  shareBar: css`
    display: inline-block;
    vertical-align: middle;
    width: 80px;
    height: 6px;
    border-radius: 3px;
    background: ${theme.colors.background.secondary};
    margin-right: ${theme.spacing(1)};
  `,
  shareFill: css`
    height: 100%;
    border-radius: 3px;
    background: ${theme.colors.error.main};
    opacity: 0.7;
  `,
  shareLabel: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  footer: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: ${theme.spacing(1, 1, 0.5)};
  `,
  footerCount: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
