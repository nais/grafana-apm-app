import React, { useMemo, useState } from 'react';
import { Badge, Button, Icon, IconButton, Pagination, RadioButtonGroup, Tooltip, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import {
  getIssues,
  getTriageStates,
  getFrontendVersions,
  postTriageAction,
  IssueSource,
  TriageState,
  UnifiedIssue,
} from '../../../../api/client';
import { useFetch } from '../../../../utils/useFetch';
import { useTimeRange } from '../../../../utils/timeRange';
import { useUrlParams } from '../../../../utils/useUrlState';
import { useUserMutes } from '../../../../utils/userStorage';
import { usePluginDatasources } from '../../../../utils/datasources';
import { buildExceptionTracesExploreUrl } from '../../../../utils/explore';
import { DataState } from '../../../../components/DataState';

interface IssuesTableProps {
  namespace: string;
  service: string;
  environment?: string;
  /**
   * Compact mode (Frontend tab, #69 P6): browser issues only (source filter
   * hidden and locked), capped to a handful of rows with no pager, and an
   * "All issues →" link out to the full Issues tab. Full triage lives there.
   */
  compact?: boolean;
}

type StatusFilter = 'unresolved' | 'all' | 'resolved' | 'ignored';

const FILTER_OPTIONS: Array<{ label: string; value: StatusFilter }> = [
  { label: 'Unresolved', value: 'unresolved' },
  { label: 'All', value: 'all' },
  { label: 'Resolved', value: 'resolved' },
  { label: 'Ignored', value: 'ignored' },
];

type SourceFilter = 'all' | IssueSource;

const SOURCE_OPTIONS: Array<{ label: string; value: SourceFilter }> = [
  { label: 'All sources', value: 'all' },
  { label: 'Browser', value: 'browser' },
  { label: 'Server', value: 'server' },
];

/**
 * Fingerprint-grouped exception list (#62 Phase 0) with triage (#57):
 * resolve/ignore/mute state per issue, shared across users via the backend's
 * annotations event log (mutes are per-user). The default view hides
 * resolved, ignored, and muted issues; resolved issues that reappear after a
 * newer deploy bubble to the top as Regressed.
 */
export function IssuesTable({ namespace, service, environment, compact = false }: IssuesTableProps) {
  const styles = useStyles2(getStyles);
  const { fromMs, toMs, from, to } = useTimeRange();
  const updateParams = useUrlParams();
  const ds = usePluginDatasources(environment || undefined);

  const { data, loading, error } = useFetch(
    () => getIssues(namespace, service, fromMs, toMs, environment),
    [namespace, service, fromMs, toMs, environment]
  );
  // Triage state and deploy info load non-blocking: the table renders even
  // when either fetch fails (badges/filtering simply degrade).
  const { data: triageStates, refetch: refetchTriage } = useFetch(
    () => getTriageStates(namespace, service),
    [namespace, service]
  );
  const { data: versions } = useFetch(
    () => getFrontendVersions(namespace, service, fromMs, toMs, environment),
    [namespace, service, fromMs, toMs, environment]
  );
  const { mutes, toggleMute } = useUserMutes(namespace, service);

  const [filter, setFilter] = useState<StatusFilter>('unresolved');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(compact ? 'browser' : 'all');
  const [showMuted, setShowMuted] = useState(false);
  // Optimistic overrides after a POST — avoids refetching the whole table.
  const [overrides, setOverrides] = useState<Record<string, TriageState>>({});

  const act = async (fingerprint: string, action: 'resolve' | 'ignore' | 'unresolve') => {
    const newState = await postTriageAction(namespace, service, fingerprint, {
      action,
      resolvedInVersion: action === 'resolve' ? versions?.latestVersion : undefined,
    });
    setOverrides((prev) => ({ ...prev, [fingerprint]: newState }));
  };

  const groups = data?.issues ?? [];
  const totalCount = groups.reduce((sum, g) => sum + g.count, 0);

  // Latest deploy timestamp — the naive Phase 1 regression rule (#57/#64):
  // an issue resolved BEFORE the newest deploy that still occurs in the
  // current result set is treated as Regressed. Approximation documented in
  // the PRD: occurrences in a historical window may predate the resolve.
  const latestDeployMs = useMemo(() => {
    const latest = versions?.versions.find((v) => v.version === versions.latestVersion);
    return latest?.deployedAtMs ?? 0;
  }, [versions]);

  const stateOf = (fp: string): TriageState | undefined => overrides[fp] ?? triageStates?.[fp];
  const isRegressed = (g: UnifiedIssue): boolean => {
    const st = stateOf(g.fingerprint);
    return !!st && st.status === 'resolved' && latestDeployMs > 0 && st.updatedAt < latestDeployMs;
  };

  const { rows, mutedCount } = useMemo(() => {
    let mutedCount = 0;
    const visible: UnifiedIssue[] = [];
    for (const g of groups) {
      if (sourceFilter !== 'all' && g.source !== sourceFilter) {
        continue;
      }
      const st = stateOf(g.fingerprint);
      const status = st?.status ?? 'active';
      const regressed = isRegressed(g);
      if (filter === 'unresolved') {
        if (mutes.has(g.fingerprint) && !showMuted) {
          mutedCount++;
          continue;
        }
        // Regressed issues re-surface in the default view despite 'resolved'.
        if ((status === 'resolved' && !regressed) || status === 'ignored') {
          continue;
        }
      } else if (filter === 'resolved' && status !== 'resolved') {
        continue;
      } else if (filter === 'ignored' && status !== 'ignored') {
        continue;
      }
      visible.push(g);
    }
    // Regressed bubbles to the top regardless of count order.
    visible.sort((a, b) => Number(isRegressed(b)) - Number(isRegressed(a)));
    return { rows: visible, mutedCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, triageStates, overrides, mutes, filter, sourceFilter, showMuted, latestDeployMs]);

  const [rawPage, setPage] = useState(1);
  const totalPages = compact ? 1 : Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = compact ? 1 : Math.min(rawPage, totalPages);
  const pageGroups = compact ? rows.slice(0, COMPACT_ROW_LIMIT) : rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h6 className={styles.title}>Top Exceptions</h6>
        <span className={styles.subtitle}>Frontend and backend errors grouped by stable fingerprint</span>
        <div className={styles.headerSpacer} />
        {!compact && (
          <RadioButtonGroup size="sm" options={SOURCE_OPTIONS} value={sourceFilter} onChange={setSourceFilter} />
        )}
        <RadioButtonGroup size="sm" options={FILTER_OPTIONS} value={filter} onChange={setFilter} />
      </div>
      <DataState
        loading={loading}
        error={error ? 'Failed to load issues' : data?.unavailable ? 'Loki is not available' : null}
        empty={groups.length === 0}
        loadingText="Loading issues…"
        emptyTitle="No issues"
        emptyMessage="No errors in the selected time range."
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Error</th>
              <th className={styles.shareCol}>Share</th>
              <th className={styles.num}>Occurrences</th>
              <th className={styles.num}>
                {data?.sessionsWindowSeconds ? (
                  <Tooltip content="Distinct sessions exceed the Loki series limit over the full range, so session counts cover a recent window only.">
                    <span>Sessions (last {Math.round(data.sessionsWindowSeconds / 60)}m)</span>
                  </Tooltip>
                ) : (
                  'Sessions'
                )}
              </th>
              <th className={styles.actionsCol} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {pageGroups.map((g) => (
              <IssueRow
                key={g.fingerprint}
                group={g}
                tracesUrl={
                  g.source === 'server' && ds.tracesUid
                    ? buildExceptionTracesExploreUrl(ds.tracesUid, service, {
                        exceptionType: g.types?.[0],
                        from,
                        to,
                      })
                    : undefined
                }
                state={stateOf(g.fingerprint)}
                regressed={isRegressed(g)}
                muted={mutes.has(g.fingerprint)}
                totalCount={totalCount}
                sessionsUnavailable={data?.sessionsUnavailable}
                onOpen={() =>
                  g.source === 'server'
                    ? // Server issues have no member hashes to drive the drawer —
                      // deep-link to the Logs tab pre-filtered on the error title.
                      updateParams({ tab: 'logs', logSearch: g.title.slice(0, 60) })
                    : updateParams({ issueId: g.fingerprint })
                }
                onAct={(action) => act(g.fingerprint, action).then(refetchTriage)}
                onMute={() => toggleMute(g.fingerprint)}
              />
            ))}
          </tbody>
        </table>
        {filter === 'unresolved' && mutedCount > 0 && !showMuted && (
          <button type="button" className={styles.mutedToggle} onClick={() => setShowMuted(true)}>
            {mutedCount} muted for me — show
          </button>
        )}
        {showMuted && (
          <button type="button" className={styles.mutedToggle} onClick={() => setShowMuted(false)}>
            hide muted
          </button>
        )}
        <div className={styles.footer}>
          <span className={styles.footerCount}>
            {rows.length === 1 ? '1 issue' : `${rows.length} issues`}
            {!compact &&
              totalPages > 1 &&
              ` · showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, rows.length)}`}
          </span>
          {compact ? (
            <Button size="sm" variant="secondary" fill="text" onClick={() => updateParams({ tab: 'issues' })}>
              All issues →
            </Button>
          ) : (
            <Pagination currentPage={page} numberOfPages={totalPages} onNavigate={setPage} hideWhenSinglePage />
          )}
        </div>
      </DataState>
    </div>
  );
}

const PAGE_SIZE = 10;
/** Compact mode row cap (Frontend tab, #69 P6) — no pager, just "All issues →". */
const COMPACT_ROW_LIMIT = 5;

function IssueRow({
  group,
  tracesUrl,
  state,
  regressed,
  muted,
  totalCount,
  sessionsUnavailable,
  onOpen,
  onAct,
  onMute,
}: {
  group: UnifiedIssue;
  /** Explore deep link to traces carrying this issue's exception events (#63 P2, server issues). */
  tracesUrl?: string;
  state?: TriageState;
  regressed: boolean;
  muted: boolean;
  totalCount: number;
  sessionsUnavailable?: boolean;
  onOpen: () => void;
  onAct: (action: 'resolve' | 'ignore' | 'unresolve') => void;
  onMute: () => void;
}) {
  const styles = useStyles2(getStyles);
  const share = totalCount > 0 ? group.count / totalCount : 0;
  const status = state?.status ?? 'active';
  return (
    <tr
      className={styles.row}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
    >
      <td className={styles.errorCell}>
        {group.source === 'server' ? (
          <Tooltip content="Backend error from server logs — opens the Logs tab pre-filtered.">
            <Badge className={styles.sourceBadge} text="server" color="orange" icon="database" />
          </Tooltip>
        ) : (
          <Badge className={styles.sourceBadge} text="browser" color="blue" icon="monitor" />
        )}
        <span className={styles.errorTitle}>{group.title}</span>
        {group.source === 'server' && (
          <Icon className={styles.externalIcon} name="external-link-alt" size="sm" aria-label="Opens Logs tab" />
        )}
        {group.memberHashes.length > 1 && (
          <Tooltip
            content={`Merged from ${group.memberHashes.length} raw exception hashes whose messages differ only by dynamic content (ids, urls, timestamps).`}
          >
            <Badge className={styles.badge} text={`merged ×${group.memberHashes.length}`} color="purple" />
          </Tooltip>
        )}
        {regressed ? (
          <Tooltip content={`Resolved by ${state?.updatedBy}, but occurrences continue after a newer deploy.`}>
            <Badge className={styles.badge} text="Regressed" color="red" icon="repeat" />
          </Tooltip>
        ) : (
          <>
            {status === 'resolved' && <Badge className={styles.badge} text="Resolved" color="green" />}
            {status === 'ignored' && <Badge className={styles.badge} text="Ignored" color="darkgrey" />}
          </>
        )}
        {state?.assignee && <Badge className={styles.badge} text={`@${state.assignee}`} color="blue" icon="user" />}
        {muted && <Badge className={styles.badge} text="muted" color="darkgrey" icon="bell-slash" />}
      </td>
      <td className={styles.shareCol}>
        <div className={styles.shareBar}>
          <div className={styles.shareFill} style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} />
        </div>
        <span className={styles.shareLabel}>{Math.round(share * 100)}%</span>
      </td>
      <td className={styles.num}>{Math.round(group.count)}</td>
      <td className={styles.num}>
        {group.source === 'server' || sessionsUnavailable ? '—' : Math.round(group.sessions)}
      </td>
      <td className={styles.actionsCol} onClick={(e) => e.stopPropagation()}>
        <span className={styles.actions}>
          {status === 'active' ? (
            <>
              <IconButton name="check" size="sm" tooltip="Resolve" onClick={() => onAct('resolve')} />
              <IconButton name="eye-slash" size="sm" tooltip="Ignore" onClick={() => onAct('ignore')} />
            </>
          ) : (
            <IconButton name="history" size="sm" tooltip="Reopen (unresolve)" onClick={() => onAct('unresolve')} />
          )}
          {tracesUrl && (
            <a href={tracesUrl} target="_blank" rel="noopener noreferrer" aria-label="View example traces">
              <IconButton name="gf-traces" size="sm" tooltip="View traces with this exception (Tempo ≥ 2.6)" />
            </a>
          )}
          <IconButton
            name={muted ? 'bell' : 'bell-slash'}
            size="sm"
            tooltip={muted ? 'Unmute for me' : 'Mute for me'}
            onClick={onMute}
          />
        </span>
      </td>
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
  headerSpacer: css`
    flex: 1;
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
  sourceBadge: css`
    margin-right: ${theme.spacing(1)};
    vertical-align: middle;
  `,
  externalIcon: css`
    margin-left: ${theme.spacing(0.5)};
    color: ${theme.colors.text.secondary};
    opacity: 0.7;
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
  actionsCol: css`
    white-space: nowrap;
    width: 1%;
  `,
  actions: css`
    display: inline-flex;
    gap: ${theme.spacing(0.5)};
    opacity: 0.75;
  `,
  mutedToggle: css`
    background: none;
    border: none;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    cursor: pointer;
    padding: ${theme.spacing(0.5, 1)};
    &:hover {
      color: ${theme.colors.text.primary};
    }
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
