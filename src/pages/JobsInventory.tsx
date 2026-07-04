import React, { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import {
  Alert,
  Badge,
  Combobox,
  FilterPill,
  Icon,
  Input,
  LoadingPlaceholder,
  MultiCombobox,
  Tooltip,
  useStyles2,
} from '@grafana/ui';
import { GrafanaTheme2, dateTime } from '@grafana/data';
import { css } from '@emotion/css';
import { getJobs, JobEntry } from '../api/jobs';
import { useTimeRange } from '../utils/timeRange';
import { QUICK_TIME_RANGES } from '../utils/timeRangeOptions';
import { useAppNavigate, sanitizeParam } from '../utils/navigation';
import { useFetch } from '../utils/useFetch';
import { RefreshControl } from '../components/RefreshControl';
import { usePluginDatasources } from '../utils/datasources';
import { buildLokiExploreUrl } from '../utils/explore';
import { createServiceSearchIndex, searchServices } from '../utils/serviceSearch';

type SortField = 'name' | 'namespace' | 'cluster' | 'schedule' | 'lastRun' | 'nextRun' | 'streak';
type SortDir = 'asc' | 'desc';

/** Compact relative time ("5m ago"); empty string for missing/zero timestamps. */
function relTime(ms?: number): string {
  if (!ms) {
    return '';
  }
  return dateTime(ms).fromNow();
}

/** Format a duration in whole seconds as "Xs" / "Xm Ys" / "Xh Ym". */
function formatSeconds(sec?: number): string {
  if (sec == null || sec < 0) {
    return '—';
  }
  if (sec < 60) {
    return `${sec}s`;
  }
  if (sec < 3600) {
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  }
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function outcomeBadge(job: JobEntry) {
  const lr = job.lastRun;
  if (!lr) {
    return <Badge text="never run" color="darkgrey" />;
  }
  switch (lr.outcome) {
    case 'succeeded':
      return <Badge text="succeeded" color="green" icon="check" />;
    case 'failed':
      return <Badge text={lr.reason || 'failed'} color="red" icon="exclamation-triangle" />;
    case 'running':
      return <Badge text="running" color="blue" icon="fa fa-spinner" />;
    default:
      return <Badge text="unknown" color="darkgrey" />;
  }
}

function statusDot(status: JobEntry['status']): string {
  switch (status) {
    case 'failing':
      return '🔴';
    case 'ok':
      return '🟢';
    default:
      return '⚪';
  }
}

function JobsInventory() {
  const styles = useStyles2(getStyles);
  const appNavigate = useAppNavigate();
  const { from, fromMs, toMs, setTimeRange, refresh: refreshTimeRange } = useTimeRange();
  const { logsUid } = usePluginDatasources();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data, loading, error, refetch } = useFetch(() => getJobs(fromMs, toMs), [fromMs, toMs]);

  const jobs = useMemo(() => data?.jobs ?? [], [data]);
  const available = data?.available ?? true;

  // UI state from query params (persisted across navigation).
  const rawNsFilter = searchParams.get('namespace') ?? '';
  const nsFilters = useMemo(() => sanitizeParam(rawNsFilter).split(',').filter(Boolean), [rawNsFilter]);
  const search = searchParams.get('q') ?? '';
  const showFailingOnly = searchParams.get('status') === 'failing';
  const sortField: SortField = (searchParams.get('sort') as SortField) || 'name';
  const sortDir: SortDir = (searchParams.get('dir') as SortDir) || 'asc';

  const updateParams = (updates: Record<string, string | null>) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, val] of Object.entries(updates)) {
          if (val) {
            next.set(key, val);
          } else {
            next.delete(key);
          }
        }
        return next;
      },
      { replace: true }
    );
  };

  const namespaceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const j of jobs) {
      if (j.namespace) {
        set.add(j.namespace);
      }
    }
    return [...set].sort().map((n) => ({ label: n, value: n }));
  }, [jobs]);

  const searchIndex = useMemo(() => createServiceSearchIndex(jobs), [jobs]);
  const isSearching = search.trim().length > 0;
  const searchResults = useMemo(
    () => (isSearching ? searchServices(jobs, search, searchIndex) : jobs),
    [jobs, search, searchIndex, isSearching]
  );
  const searchRank = useMemo(() => {
    const rank = new Map<JobEntry, number>();
    searchResults.forEach((j, i) => rank.set(j, i));
    return rank;
  }, [searchResults]);

  let filtered = jobs;
  if (nsFilters.length > 0) {
    filtered = filtered.filter((j) => nsFilters.includes(j.namespace));
  }
  if (showFailingOnly) {
    filtered = filtered.filter((j) => j.status === 'failing');
  }
  if (isSearching) {
    const matched = new Set(searchResults);
    filtered = filtered.filter((j) => matched.has(j));
  }

  const dir = sortDir === 'desc' ? -1 : 1;
  const isDefaultSort = sortField === 'name' && sortDir === 'asc';
  filtered = [...filtered].sort((a, b) => {
    if (isSearching && isDefaultSort) {
      return (searchRank.get(a) ?? 0) - (searchRank.get(b) ?? 0);
    }
    let cmp = 0;
    switch (sortField) {
      case 'name':
        cmp = a.name.localeCompare(b.name);
        break;
      case 'namespace':
        cmp = a.namespace.localeCompare(b.namespace);
        break;
      case 'cluster':
        cmp = a.cluster.localeCompare(b.cluster);
        break;
      case 'schedule':
        cmp = (a.schedule ?? '').localeCompare(b.schedule ?? '');
        break;
      case 'lastRun':
        cmp = (a.lastRun?.startMs ?? 0) - (b.lastRun?.startMs ?? 0);
        break;
      case 'nextRun':
        cmp = (a.nextScheduleMs ?? 0) - (b.nextScheduleMs ?? 0);
        break;
      case 'streak':
        cmp = a.failureStreak - b.failureStreak;
        break;
    }
    if (cmp !== 0) {
      return cmp * dir;
    }
    return a.name.localeCompare(b.name);
  });

  const failingCount = useMemo(() => jobs.filter((j) => j.status === 'failing').length, [jobs]);

  const isRelativeRange = from.startsWith('now');
  const handleRefresh = () => {
    if (isRelativeRange) {
      refreshTimeRange();
    } else {
      refetch();
    }
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      updateParams({ dir: sortDir === 'asc' ? 'desc' : 'asc' });
    } else {
      const defaultDir = field === 'streak' || field === 'lastRun' || field === 'nextRun' ? 'desc' : 'asc';
      updateParams({ sort: field, dir: defaultDir });
    }
  };

  const sortIcon = (field: SortField) =>
    sortField !== field ? null : <Icon name={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'} size="sm" />;

  const openLogs = (job: JobEntry) => {
    const url = buildLokiExploreUrl(logsUid, job.name, {
      namespace: job.namespace,
      from,
      to: 'now',
    });
    window.open(url, '_blank', 'noopener');
  };

  return (
    <PluginPage>
      <div className={styles.container}>
        {error && (
          <Alert severity="error" title="Error">
            {error}
          </Alert>
        )}
        {loading && <LoadingPlaceholder text="Loading jobs..." />}

        {!loading && !available && (
          <Alert severity="info" title="Job metrics not available">
            {data?.note ??
              'kube-state-metrics job families are not exposed on the metrics datasource. The platform must scrape kube_cronjob_* and kube_job_* series for this view to work.'}
          </Alert>
        )}

        {!loading && available && (
          <>
            <div className={styles.toolbar}>
              <div className={styles.scopeRow}>
                <div className={styles.filterGroup}>
                  <div className={styles.filterItem}>
                    <Input
                      prefix={<Icon name="search" />}
                      placeholder="Filter jobs..."
                      value={search}
                      onChange={(e) => updateParams({ q: e.currentTarget.value || null })}
                    />
                  </div>
                  <div className={styles.filterItem}>
                    <MultiCombobox
                      options={namespaceOptions}
                      value={nsFilters}
                      onChange={(selected) =>
                        updateParams({ namespace: selected.length ? selected.map((o) => o.value).join(',') : null })
                      }
                      placeholder="All namespaces"
                    />
                  </div>
                </div>
                <Combobox
                  options={QUICK_TIME_RANGES}
                  value={from}
                  onChange={(v) => setTimeRange(v?.value ?? 'now-1h', 'now')}
                  width={22}
                  prefixIcon="clock-nine"
                />
                <RefreshControl onRefresh={handleRefresh} />
              </div>
              <div className={styles.viewRow}>
                <FilterPill
                  icon="exclamation-circle"
                  label={`Failing${failingCount > 0 ? ` (${failingCount})` : ''}`}
                  selected={showFailingOnly}
                  onClick={() => updateParams({ status: showFailingOnly ? null : 'failing' })}
                />
              </div>
            </div>

            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.dotCol} />
                  <th className={styles.sortable} onClick={() => toggleSort('name')}>
                    Name {sortIcon('name')}
                  </th>
                  <th className={styles.sortable} onClick={() => toggleSort('namespace')}>
                    Namespace {sortIcon('namespace')}
                  </th>
                  <th className={styles.sortable} onClick={() => toggleSort('cluster')}>
                    Cluster {sortIcon('cluster')}
                  </th>
                  <th className={styles.sortable} onClick={() => toggleSort('schedule')}>
                    Schedule {sortIcon('schedule')}
                  </th>
                  <th className={styles.sortable} onClick={() => toggleSort('lastRun')}>
                    Last run {sortIcon('lastRun')}
                  </th>
                  <th className={styles.sortable} onClick={() => toggleSort('nextRun')}>
                    Next run {sortIcon('nextRun')}
                  </th>
                  <th className={styles.sortable} onClick={() => toggleSort('streak')}>
                    Fail streak {sortIcon('streak')}
                  </th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((job) => (
                  <tr
                    key={`${job.cluster}/${job.namespace}/${job.name}`}
                    className={styles.row}
                    onClick={() => openLogs(job)}
                  >
                    <td className={styles.dotCell}>{statusDot(job.status)}</td>
                    <td>
                      <span className={styles.nameCell}>{job.name}</span>
                      {job.kind === 'Job' && <Badge text="one-shot" color="darkgrey" className={styles.kindBadge} />}
                    </td>
                    <td className={styles.muted}>
                      <button
                        className={styles.nsLink}
                        onClick={(e) => {
                          e.stopPropagation();
                          appNavigate(`namespaces/${encodeURIComponent(job.namespace)}`);
                        }}
                      >
                        {job.namespace}
                      </button>
                    </td>
                    <td className={styles.muted}>{job.cluster}</td>
                    <td className={styles.schedule}>{job.schedule || '—'}</td>
                    <td>
                      <div className={styles.lastRunCell}>
                        {outcomeBadge(job)}
                        {job.lastRun?.startMs ? (
                          <Tooltip content={dateTime(job.lastRun.startMs).format('YYYY-MM-DD HH:mm:ss')}>
                            <span className={styles.muted}>{relTime(job.lastRun.startMs)}</span>
                          </Tooltip>
                        ) : null}
                      </div>
                    </td>
                    <td className={styles.muted}>
                      {job.nextScheduleMs ? (
                        <Tooltip content={dateTime(job.nextScheduleMs).format('YYYY-MM-DD HH:mm:ss')}>
                          <span>{relTime(job.nextScheduleMs)}</span>
                        </Tooltip>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {job.failureStreak > 0 ? (
                        <span className={styles.streak}>{job.failureStreak}</span>
                      ) : (
                        <span className={styles.muted}>0</span>
                      )}
                    </td>
                    <td className={styles.muted}>{formatSeconds(job.lastRun?.durationSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {filtered.length === 0 && (
              <Alert severity="info" title="No jobs found">
                {jobs.length === 0
                  ? 'No CronJobs or Jobs were found in kube-state-metrics.'
                  : 'No jobs match the current filters.'}
              </Alert>
            )}
          </>
        )}
      </div>
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    padding: 0;
    overflow: hidden;
  `,
  toolbar: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(2)};
    z-index: 2;
  `,
  scopeRow: css`
    display: flex;
    gap: ${theme.spacing(1)};
    align-items: center;
  `,
  viewRow: css`
    display: flex;
    gap: ${theme.spacing(1)};
    align-items: center;
    flex-wrap: wrap;
  `,
  filterGroup: css`
    display: flex;
    flex: 1;
    gap: ${theme.spacing(1)};
    align-items: center;
    min-width: 0;
  `,
  filterItem: css`
    flex: 1;
    min-width: 160px;
    max-width: 320px;
  `,
  table: css`
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    th {
      text-align: left;
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      color: ${theme.colors.text.secondary};
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      border-bottom: 1px solid ${theme.colors.border.medium};
      white-space: nowrap;
      user-select: none;
    }
    td {
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: middle;
    }
  `,
  sortable: css`
    cursor: pointer;
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
  row: css`
    cursor: pointer;
    &:hover {
      background: ${theme.colors.background.secondary};
    }
  `,
  dotCol: css`
    width: 28px;
    padding: 0 !important;
  `,
  dotCell: css`
    text-align: center;
    font-size: 11px;
  `,
  nameCell: css`
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
  `,
  kindBadge: css`
    margin-left: ${theme.spacing(1)};
  `,
  muted: css`
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
  `,
  schedule: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
  `,
  lastRunCell: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  streak: css`
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
  `,
  nsLink: css`
    background: none;
    border: none;
    padding: 0;
    color: ${theme.colors.text.link};
    cursor: pointer;
    font-size: inherit;
    &:hover {
      text-decoration: underline;
    }
  `,
});

export default JobsInventory;
