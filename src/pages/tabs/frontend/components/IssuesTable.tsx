import React from 'react';
import { Badge, Tooltip, useStyles2 } from '@grafana/ui';
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
              <th className={styles.num}>Occurrences</th>
              <th className={styles.num}>Sessions</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <IssueRow key={g.fingerprint} group={g} onOpen={() => updateParams({ issueId: g.fingerprint })} />
            ))}
          </tbody>
        </table>
      </DataState>
    </div>
  );
}

function IssueRow({ group, onOpen }: { group: ExceptionGroup; onOpen: () => void }) {
  const styles = useStyles2(getStyles);
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
});
