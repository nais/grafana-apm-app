import React, { useMemo, useState } from 'react';
import { useStyles2, Icon, Badge, Tooltip } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getTopQueries, TopQuery } from '../../../api/analytics';
import { useFetch } from '../../../utils/useFetch';
import { DataState } from '../../../components/DataState';
import { SortHeader, useTableSort, getTableStyles } from '../../../components/SortableTable';
import { DepTypeIcon } from '../../../components/DepTypeIcon';
import { formatDuration } from '../../../utils/format';
import { buildExploreUrl } from '../../../utils/explore';

type SortField = 'statement' | 'dbSystem' | 'count' | 'totalTimeMs' | 'avgTimeMs' | 'p95Ms';

interface TopQueriesSectionProps {
  namespace: string;
  service: string;
  fromMs: number;
  toMs: number;
  tracesUid: string;
}

/**
 * "Top queries" — the Database tab's per-statement analysis (issue #119 §4.2).
 *
 * Answers the app-developer question "which of my queries should I optimize?"
 * by aggregating normalized db.statement fingerprints from a bounded, cached
 * Tempo trace search (the backend owns the cost bounds and normalization —
 * every statement here is a fingerprint, never a raw literal, §6). The one
 * list is re-sortable by the three PRD lenses: total time (the expensive one),
 * count (the frequent one), and p95 (the tail).
 */
export function TopQueriesSection({ namespace, service, fromMs, toMs, tracesUid }: TopQueriesSectionProps) {
  const styles = useStyles2(getStyles);
  const { sortField, sortDir, toggleSort, comparator } = useTableSort<SortField>('totalTimeMs', 'desc');

  const {
    data,
    loading,
    error: fetchError,
  } = useFetch(
    () => getTopQueries(namespace, service, fromMs, toMs, tracesUid),
    [namespace, service, fromMs, toMs, tracesUid],
    { skip: !tracesUid }
  );

  const queries = useMemo(() => data?.queries ?? [], [data]);
  const sorted = useMemo(() => [...queries].sort(comparator), [queries, comparator]);

  const unavailable = data?.mode === 'unavailable';
  const isEmpty = !loading && !fetchError && !unavailable && queries.length === 0;

  return (
    <div className={styles.section}>
      <h4 className={styles.sectionTitle}>Top queries</h4>
      <p className={styles.sectionSubtitle}>
        Normalized database statements aggregated from a bounded, cached sample of this service&apos;s traces. Sort by
        total time (the most expensive), count (the most frequent), or P95 (the slow tail) to decide what to optimize.
        Literals are stripped to a fingerprint before display.
      </p>

      <DataState
        loading={loading}
        error={fetchError ?? null}
        empty={isEmpty}
        loadingText="Sampling traces for query statements…"
        emptyTitle="No query statements found"
        emptyMessage="No database client spans carrying db.statement were found in the sampled window. Widen the range, or check that the service exports CLIENT spans with a db.statement attribute."
      >
        {unavailable ? (
          <div className={styles.notice}>
            <Icon name="exclamation-triangle" />
            <span>
              {data?.note || 'Trace search is currently unavailable. Try again shortly or narrow the time range.'}
            </span>
          </div>
        ) : (
          <>
            <table className={styles.table} aria-label="Top database queries">
              <colgroup>
                <col style={{ width: 'auto' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '44px' }} />
              </colgroup>
              <thead>
                <tr>
                  <SortHeader
                    field="statement"
                    label="Statement"
                    sortField={sortField}
                    sortDir={sortDir}
                    onSort={toggleSort}
                  />
                  <SortHeader
                    field="dbSystem"
                    label="System"
                    sortField={sortField}
                    sortDir={sortDir}
                    onSort={toggleSort}
                  />
                  <SortHeader field="count" label="Count" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                  <SortHeader
                    field="totalTimeMs"
                    label="Total time"
                    sortField={sortField}
                    sortDir={sortDir}
                    onSort={toggleSort}
                  />
                  <SortHeader
                    field="avgTimeMs"
                    label="Avg"
                    sortField={sortField}
                    sortDir={sortDir}
                    onSort={toggleSort}
                  />
                  <SortHeader field="p95Ms" label="P95" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                  <th scope="col" aria-label="Trace link" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((q, i) => (
                  <QueryRow key={`${q.dbSystem}:${q.statement}:${i}`} query={q} tracesUid={tracesUid} />
                ))}
              </tbody>
            </table>
            <p className={styles.footnote}>
              {data && (
                <>
                  Sampled {data.sampled.toLocaleString()} DB span{data.sampled === 1 ? '' : 's'} over the last{' '}
                  {formatWindow(data.windowSeconds)}
                  {data.truncated && ' (bounded sample — the scan limit was reached)'}.
                </>
              )}
            </p>
          </>
        )}
      </DataState>
    </div>
  );
}

function QueryRow({ query, tracesUid }: { query: TopQuery; tracesUid: string }) {
  const styles = useStyles2(getStyles);
  const [expanded, setExpanded] = useState(false);
  const isKeyValue = /redis|valkey|keydb|memcached/i.test(query.dbSystem);
  const opWord = isKeyValue ? 'operation' : 'query';

  const traceHref = query.traceId
    ? buildExploreUrl({
        datasourceUid: tracesUid,
        queries: [{ refId: 'A', queryType: 'traceql', query: query.traceId }],
      })
    : undefined;

  return (
    <tr>
      <td>
        <button
          type="button"
          className={expanded ? styles.statementExpanded : styles.statement}
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Collapse' : 'Expand full statement'}
        >
          {query.statement}
        </button>
        {query.table && <span className={styles.tableTag}>{query.table}</span>}
      </td>
      <td>
        <span className={styles.systemCell}>
          <DepTypeIcon type={query.dbSystem} size={16} />
          <span>{query.dbSystem}</span>
        </span>
      </td>
      <td className={styles.numCell}>{query.count.toLocaleString()}</td>
      <td className={styles.numCell}>{formatDuration(query.totalTimeMs, 'ms')}</td>
      <td className={styles.numCell}>{formatDuration(query.avgTimeMs, 'ms')}</td>
      <td className={styles.numCell}>{formatDuration(query.p95Ms, 'ms')}</td>
      <td className={styles.linkCell}>
        {traceHref ? (
          <Tooltip content={`View a representative trace for this ${opWord}`}>
            <a
              href={traceHref}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.traceLink}
              aria-label="View representative trace"
            >
              <Icon name="compass" size="sm" />
            </a>
          </Tooltip>
        ) : (
          <Badge text="—" color="darkgrey" />
        )}
      </td>
    </tr>
  );
}

function formatWindow(seconds: number): string {
  if (seconds >= 3600) {
    const h = seconds / 3600;
    return `${h % 1 === 0 ? h : h.toFixed(1)}h`;
  }
  if (seconds >= 60) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${seconds}s`;
}

const getStyles = (theme: GrafanaTheme2) => ({
  ...getTableStyles(theme),
  section: css`
    display: flex;
    flex-direction: column;
  `,
  sectionTitle: css`
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    margin: 0 0 ${theme.spacing(0.5)} 0;
    color: ${theme.colors.text.primary};
  `,
  sectionSubtitle: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin: 0 0 ${theme.spacing(1)} 0;
  `,
  statement: css`
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.primary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    &:hover {
      color: ${theme.colors.text.link};
    }
  `,
  statementExpanded: css`
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.primary};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  tableTag: css`
    display: inline-block;
    margin-top: ${theme.spacing(0.5)};
    padding: 0 ${theme.spacing(0.75)};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
  systemCell: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    text-transform: capitalize;
  `,
  linkCell: css`
    text-align: center;
  `,
  traceLink: css`
    color: ${theme.colors.text.secondary};
    &:hover {
      color: ${theme.colors.text.link};
    }
  `,
  notice: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  footnote: css`
    margin: ${theme.spacing(1)} 0 0 0;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
});
