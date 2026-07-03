import React, { useState } from 'react';
import { Icon, Input, Tooltip, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getFrontendSessions, SessionSummary } from '../../../../api/client';
import { useFetch } from '../../../../utils/useFetch';
import { useTimeRange } from '../../../../utils/timeRange';
import { useUrlParams } from '../../../../utils/useUrlState';
import { useDebouncedValue } from '../../../../utils/debounce';
import { DataState } from '../../../../components/DataState';

interface SessionsPanelProps {
  namespace: string;
  service: string;
  environment?: string;
}

/**
 * Session/user search (M5): the user-centric entry point. Recent Faro
 * sessions sorted by error count then recency, searchable by session id,
 * user id, or user email — a support ticket in, a session out. Row click
 * deep-links to the Logs tab pre-filtered on the session id.
 */
export function SessionsPanel({ namespace, service, environment }: SessionsPanelProps) {
  const styles = useStyles2(getStyles);
  const { fromMs, toMs } = useTimeRange();
  const updateParams = useUrlParams();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  const { data, loading, error } = useFetch(
    () => getFrontendSessions(namespace, service, fromMs, toMs, environment, debouncedSearch),
    [namespace, service, fromMs, toMs, environment, debouncedSearch]
  );

  const sessions = data?.sessions ?? [];
  // Most apps don't call setUser yet — hide the column until it carries data.
  const hasUserData = sessions.some((s) => s.userId || s.userEmail);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h6 className={styles.title}>Sessions</h6>
        <span className={styles.subtitle}>Sessions with the most errors — click through to the session&apos;s logs</span>
        <div className={styles.search}>
          <Input
            prefix={<Icon name="search" />}
            placeholder="Session id, user id, or email…"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            width={32}
          />
        </div>
      </div>
      <DataState
        loading={loading}
        error={error ? 'Failed to load sessions' : data?.unavailable ? 'Loki is not available' : null}
        empty={sessions.length === 0}
        loadingText="Loading sessions…"
        emptyTitle="No sessions"
        emptyMessage={
          debouncedSearch
            ? 'No sessions match the search in the selected time range.'
            : 'No session data in the selected time range.'
        }
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Session</th>
              {hasUserData && <th>User</th>}
              <th>Browser</th>
              <th>Version</th>
              <th className={styles.num}>Pages</th>
              <th className={styles.num}>
                {data?.windowSeconds ? (
                  <Tooltip content="Sessions exceed the Loki series limit over the full range, so counts cover a recent window only.">
                    <span>Events (last {Math.round(data.windowSeconds / 60)}m)</span>
                  </Tooltip>
                ) : (
                  'Events'
                )}
              </th>
              <th className={styles.num}>Errors</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <SessionRow
                key={s.sessionId}
                session={s}
                showUser={hasUserData}
                onOpen={() => updateParams({ tab: 'logs', logSearch: s.sessionId, includeFaro: 'true' })}
              />
            ))}
          </tbody>
        </table>
        {data?.truncated && (
          <div className={styles.footerNote}>Showing the top {sessions.length} sessions — refine the search.</div>
        )}
      </DataState>
    </div>
  );
}

function SessionRow({
  session: s,
  showUser,
  onOpen,
}: {
  session: SessionSummary;
  showUser: boolean;
  onOpen: () => void;
}) {
  const styles = useStyles2(getStyles);
  const browser = [s.browser, s.os].filter(Boolean).join(' / ');
  return (
    <tr
      className={styles.row}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <td className={styles.mono} title={s.sessionId}>
        {shortId(s.sessionId)}
      </td>
      {showUser && (
        <td className={styles.user} title={s.userEmail || s.userId || undefined}>
          {s.userEmail || s.userId || '—'}
        </td>
      )}
      <td className={styles.secondary}>{browser || '—'}</td>
      <td className={styles.mono} title={s.appVersion || undefined}>
        {s.appVersion ? shortId(s.appVersion) : '—'}
      </td>
      <td className={styles.num}>{s.pages > 0 ? s.pages : '—'}</td>
      <td className={styles.num}>{Math.round(s.events)}</td>
      <td className={`${styles.num} ${s.errors > 0 ? 'session-errors' : ''}`}>{Math.round(s.errors)}</td>
      <td className={styles.secondary}>{s.lastSeenMs ? formatRelativeTime(s.lastSeenMs) : '—'}</td>
    </tr>
  );
}

/** Short display for session ids and version SHAs; full value on the title. */
function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 10) : id;
}

function formatRelativeTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  if (isNaN(diffMs) || diffMs < 0) {
    return new Date(epochMs).toLocaleString();
  }
  if (diffMs < 60_000) {
    return 'just now';
  }
  if (diffMs < 3_600_000) {
    return `${Math.floor(diffMs / 60_000)}m ago`;
  }
  if (diffMs < 86_400_000) {
    return `${Math.floor(diffMs / 3_600_000)}h ago`;
  }
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
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
    align-items: center;
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
  search: css`
    margin-left: auto;
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
    td.session-errors {
      color: ${theme.colors.error.text};
      font-weight: ${theme.typography.fontWeightMedium};
    }
  `,
  row: css`
    cursor: pointer;
    &:hover {
      background: ${theme.colors.action.hover};
    }
    &:focus-visible {
      outline: 2px solid ${theme.colors.primary.border};
      outline-offset: -2px;
    }
  `,
  mono: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    white-space: nowrap;
  `,
  user: css`
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  secondary: css`
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
  `,
  num: css`
    text-align: right;
    white-space: nowrap;
    width: 1%;
  `,
  footerNote: css`
    padding: ${theme.spacing(0.75, 1)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
