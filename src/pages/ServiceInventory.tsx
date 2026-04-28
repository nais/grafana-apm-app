import React, { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import {
  Alert,
  Badge,
  FilterPill,
  Icon,
  IconButton,
  Input,
  LoadingPlaceholder,
  MultiCombobox,
  Pagination,
  Combobox,
  Tooltip,
  useStyles2,
  useTheme2,
} from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getServices, getCapabilities, ServiceSummary, Capabilities } from '../api/client';
import { useTimeRange } from '../utils/timeRange';
import { QUICK_TIME_RANGES } from '../utils/timeRangeOptions';
import { useAppNavigate, sanitizeParam } from '../utils/navigation';
import { formatDuration } from '../utils/format';
import { sparklineColors } from '../utils/colors';
import { extractEnvironmentOptions, extractNamespaceOptions } from '../utils/options';
import { useFetch } from '../utils/useFetch';
import { FrameworkBadge } from '../components/FrameworkBadge';
import { Sparkline } from '../components/Sparkline';
import { useFavorites, serviceKey } from '../utils/useFavorites';

type SortField = 'name' | 'namespace' | 'environment' | 'p95Duration' | 'errorRate' | 'rate';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '10', value: 10 },
  { label: '25', value: 25 },
  { label: '50', value: 50 },
];

function ServiceInventory() {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const sc = sparklineColors(theme);
  const appNavigate = useAppNavigate();
  const { from, fromMs, toMs, setTimeRange } = useTimeRange();
  const { isFavorite, toggle: toggleFavorite, count: favCount } = useFavorites();
  const [searchParams, setSearchParams] = useSearchParams();

  const {
    data: fetchResult,
    loading,
    error,
  } = useFetch<{ services: ServiceSummary[]; caps: Capabilities }>(async () => {
    const [capsResult, servicesResult] = await Promise.all([getCapabilities(), getServices(fromMs, toMs, 60, false)]);
    return { caps: capsResult, services: servicesResult };
  }, [fromMs, toMs]);

  // Lazy-load sparklines after initial data is on screen (stored separately to avoid re-sorting)
  const { data: sparklineResult } = useFetch<ServiceSummary[]>(
    () => getServices(fromMs, toMs, 60, true),
    [fromMs, toMs],
    { skip: !fetchResult }
  );

  const services = useMemo(() => fetchResult?.services ?? [], [fetchResult]);
  const sparklineMap = useMemo(() => {
    if (!sparklineResult) {
      return new Map<string, ServiceSummary>();
    }
    return new Map(sparklineResult.map((s) => [`${s.namespace}/${s.name}/${s.environment ?? ''}`, s]));
  }, [sparklineResult]);
  const caps = fetchResult?.caps ?? null;

  // Read all UI state from query params (persisted across navigation)
  const rawNsFilter = searchParams.get('namespace') ?? '';
  const nsFilters = useMemo(() => sanitizeParam(rawNsFilter).split(',').filter(Boolean), [rawNsFilter]);
  const rawEnvFilter = searchParams.get('environment') ?? '';
  const envFilters = useMemo(() => sanitizeParam(rawEnvFilter).split(',').filter(Boolean), [rawEnvFilter]);
  const search = searchParams.get('q') ?? '';
  const hideSidecars = searchParams.get('hideSidecars') !== 'false'; // default: true
  const showFavoritesOnly = searchParams.get('favorites') === 'true';
  const showErrorsOnly = searchParams.get('hasErrors') === 'true';
  const sortField: SortField = (searchParams.get('sort') as SortField) || 'name';
  const sortDir: SortDir = (searchParams.get('dir') as SortDir) || 'asc';
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = parseInt(searchParams.get('pageSize') ?? '25', 10) || 25;

  // Helper to update one or more query params without losing others
  const updateParams = useCallback(
    (updates: Record<string, string | null>) => {
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
    },
    [setSearchParams]
  );

  const setNsFilters = (nss: string[]) =>
    updateParams({ namespace: nss.length > 0 ? nss.join(',') : null, page: null });
  const setEnvFilters = (envs: string[]) =>
    updateParams({ environment: envs.length > 0 ? envs.join(',') : null, page: null });
  const setSearch = (q: string) => updateParams({ q: q || null, page: null });
  const setShowFavorites = (show: boolean) => updateParams({ favorites: show ? 'true' : null, page: null });
  const setPage = (p: number) => updateParams({ page: p > 1 ? String(p) : null });
  const setPageSize = (sz: number) => updateParams({ pageSize: sz !== 25 ? String(sz) : null, page: null });

  // Compute unique namespaces for the filter dropdown
  const namespaceOptions = useMemo(() => extractNamespaceOptions(services), [services]);

  // Compute unique environments for the filter dropdown
  const envOptions = useMemo(() => extractEnvironmentOptions(services), [services]);

  // Compute unique SDK languages for the type filter
  const sdkOptions = useMemo(() => {
    const langs = new Set<string>();
    for (const s of services) {
      if (s.sdkLanguage) {
        langs.add(s.sdkLanguage);
      }
    }
    return [...langs].sort().map((l) => ({ label: l, value: l }));
  }, [services]);

  // Read SDK language filter from URL
  const rawSdkFilter = searchParams.get('sdk') ?? '';
  const sdkFilters = useMemo(() => rawSdkFilter.split(',').filter(Boolean), [rawSdkFilter]);
  const setSdkFilters = (sdks: string[]) => updateParams({ sdk: sdks.length > 0 ? sdks.join(',') : null, page: null });

  // Client-side filtering and sorting — computed every render to avoid
  // stale-closure issues with React 18 batching.
  let filtered = services;
  if (hideSidecars) {
    filtered = filtered.filter((s) => !s.isSidecar);
  }
  if (nsFilters.length > 0) {
    filtered = filtered.filter((s) => nsFilters.includes(s.namespace));
  }
  if (envFilters.length > 0) {
    filtered = filtered.filter((s) => s.environment != null && envFilters.includes(s.environment));
  }
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter((s) => s.name.toLowerCase().includes(q) || s.namespace.toLowerCase().includes(q));
  }
  if (showFavoritesOnly) {
    filtered = filtered.filter((s) => isFavorite(serviceKey(s.namespace, s.name)));
  }
  if (showErrorsOnly) {
    filtered = filtered.filter((s) => s.errorRate > 0);
  }
  if (sdkFilters.length > 0) {
    filtered = filtered.filter((s) => s.sdkLanguage != null && sdkFilters.includes(s.sdkLanguage));
  }
  // NaN-safe numeric comparison — NaN/undefined/Infinity sort to bottom
  const safeNum = (v: number) => (Number.isFinite(v) ? v : -Infinity);
  const dir = sortDir === 'desc' ? -1 : 1;
  const isDefaultSort = sortField === 'name' && sortDir === 'asc';
  filtered = [...filtered].sort((a, b) => {
    // Sort boost: favorites float to top on default sort
    if (isDefaultSort) {
      const fa = isFavorite(serviceKey(a.namespace, a.name)) ? 0 : 1;
      const fb = isFavorite(serviceKey(b.namespace, b.name)) ? 0 : 1;
      if (fa !== fb) {
        return fa - fb;
      }
    }
    let cmp = 0;
    switch (sortField) {
      case 'name':
        cmp = a.name.localeCompare(b.name);
        break;
      case 'namespace':
        cmp = a.namespace.localeCompare(b.namespace);
        break;
      case 'environment':
        cmp = (a.environment ?? '').localeCompare(b.environment ?? '');
        break;
      case 'p95Duration':
        cmp = safeNum(a.p95Duration) - safeNum(b.p95Duration);
        break;
      case 'errorRate':
        cmp = safeNum(a.errorRate) - safeNum(b.errorRate);
        break;
      case 'rate':
        cmp = safeNum(a.rate) - safeNum(b.rate);
        break;
    }
    if (cmp !== 0) {
      return cmp * dir;
    }
    // When sidecars are visible, push them after team-owned services as a secondary tiebreaker
    if (!hideSidecars) {
      const sa = a.isSidecar ? 1 : 0;
      const sb = b.isSidecar ? 1 : 0;
      if (sa !== sb) {
        return sa - sb;
      }
    }
    // Stable tiebreaker: always sort by name ascending when primary values tie
    return a.name.localeCompare(b.name);
  });

  // When viewing a single namespace with multiple envs, group rows by environment
  // with section headers instead of showing a flat environment column.
  const groupByEnv = nsFilters.length === 1 && envFilters.length === 0 && envOptions.length > 1;

  // When grouping by environment, ensure rows are grouped by env while
  // preserving the user's chosen sort order within each group (stable sort).
  // Order: prod, prod-*, dev, dev-* (production environments first).
  if (groupByEnv) {
    filtered = [...filtered].sort((a, b) => {
      const ka = envSortKey(a.environment ?? '');
      const kb = envSortKey(b.environment ?? '');
      if (ka !== kb) {
        return ka - kb;
      }
      // Within the same tier, sort alphabetically by environment name
      return (a.environment ?? '').localeCompare(b.environment ?? '');
    });
  }

  // Hide namespace column when a single namespace is selected (redundant info)
  const showNsColumn = nsFilters.length !== 1;
  // Show environment column only when there are multiple envs, no env filter, and not grouping
  const showEnvColumn = envOptions.length > 1 && envFilters.length === 0 && !groupByEnv;

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      updateParams({ dir: sortDir === 'asc' ? 'desc' : 'asc', page: null });
    } else {
      // Numeric columns default to descending (show highest first)
      const defaultDir = field === 'name' || field === 'namespace' || field === 'environment' ? 'asc' : 'desc';
      updateParams({ sort: field, dir: defaultDir, page: null });
    }
  };

  const sortIcon = (field: SortField) => {
    if (sortField !== field) {
      return null;
    }
    return <Icon name={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'} size="sm" />;
  };

  return (
    <PluginPage>
      <div className={styles.container}>
        {error && (
          <Alert severity="error" title="Error">
            {error}
          </Alert>
        )}
        {loading && <LoadingPlaceholder text="Loading services..." />}

        {!loading && caps && !caps.spanMetrics.detected && (
          <Alert severity="warning" title="No span metrics detected">
            Ensure the OpenTelemetry Collector spanmetrics connector is configured and sending data to Mimir.
          </Alert>
        )}

        {!loading && services.length > 0 && (
          <>
            <div className={styles.toolbar}>
              {/* Row 1: Data scope filters */}
              <div className={styles.scopeRow}>
                <div className={styles.filterGroup}>
                  <div className={styles.filterItem}>
                    <Input
                      prefix={<Icon name="search" />}
                      placeholder="Filter services..."
                      value={search}
                      onChange={(e) => {
                        setSearch(e.currentTarget.value);
                      }}
                    />
                  </div>
                  <div className={styles.filterItem}>
                    <MultiCombobox
                      options={namespaceOptions}
                      value={nsFilters}
                      onChange={(selected) => setNsFilters(selected.map((o) => o.value).filter(Boolean) as string[])}
                      placeholder="All namespaces"
                    />
                  </div>
                  {(envOptions.length > 1 || envFilters.length > 0) && (
                    <div className={styles.filterItem}>
                      <MultiCombobox
                        options={envOptions}
                        value={envFilters}
                        onChange={(selected) => setEnvFilters(selected.map((o) => o.value).filter(Boolean) as string[])}
                        placeholder="All environments"
                      />
                    </div>
                  )}
                  {sdkOptions.length > 1 && (
                    <div className={styles.filterItem}>
                      <MultiCombobox
                        options={sdkOptions}
                        value={sdkFilters}
                        onChange={(selected) => setSdkFilters(selected.map((o) => o.value).filter(Boolean) as string[])}
                        placeholder="All types"
                      />
                    </div>
                  )}
                </div>
                <Combobox
                  options={QUICK_TIME_RANGES}
                  value={from}
                  onChange={(v) => setTimeRange(v?.value ?? 'now-1h', 'now')}
                  width={22}
                  prefixIcon="clock-nine"
                />
              </div>
              {/* Row 2: View options (pills) */}
              <div className={styles.viewRow}>
                <FilterPill
                  icon="star"
                  label={`My Apps${favCount > 0 ? ` (${favCount})` : ''}`}
                  selected={showFavoritesOnly}
                  onClick={() => setShowFavorites(!showFavoritesOnly)}
                />
                <FilterPill
                  icon="exclamation-circle"
                  label="Has errors"
                  selected={showErrorsOnly}
                  onClick={() => updateParams({ hasErrors: showErrorsOnly ? null : 'true', page: null })}
                />
                <FilterPill
                  icon="eye-slash"
                  label="Hide sidecars"
                  selected={hideSidecars}
                  onClick={() => updateParams({ hideSidecars: hideSidecars ? 'false' : null, page: null })}
                />
              </div>
            </div>

            <table className={styles.table}>
              <colgroup>
                <col style={{ width: '32px' }} />
                <col style={{ width: '80px' }} />
                <col style={{ width: '22%' }} />
                {showNsColumn && <col style={{ width: '14%' }} />}
                {showEnvColumn && <col style={{ width: '10%' }} />}
                <col style={{ width: '18%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '18%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th className={styles.starColHeader} />
                  <th className={styles.typeColHeader}>Type</th>
                  <th className={styles.sortable} onClick={() => toggleSort('name')}>
                    Name {sortIcon('name')}
                  </th>
                  {showNsColumn && (
                    <th className={styles.sortable} onClick={() => toggleSort('namespace')}>
                      Namespace {sortIcon('namespace')}
                    </th>
                  )}
                  {showEnvColumn && (
                    <th className={styles.sortable} onClick={() => toggleSort('environment')}>
                      Environment {sortIcon('environment')}
                    </th>
                  )}
                  <th className={styles.sortable} onClick={() => toggleSort('p95Duration')}>
                    Duration, p95 {sortIcon('p95Duration')}
                  </th>
                  <th className={styles.sortable} onClick={() => toggleSort('errorRate')}>
                    Errors {sortIcon('errorRate')}
                  </th>
                  <th className={styles.sortable} onClick={() => toggleSort('rate')}>
                    Rate {sortIcon('rate')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((svc, idx) => {
                  const prevEnv = idx > 0 ? paginated[idx - 1].environment : null;
                  const showGroupHeader = groupByEnv && svc.environment !== prevEnv;
                  const colCount = 6 + (showNsColumn ? 1 : 0) + (showEnvColumn ? 1 : 0);
                  return (
                    <React.Fragment key={`${svc.namespace}/${svc.name}/${svc.environment ?? ''}`}>
                      {showGroupHeader && (
                        <tr className={styles.groupHeaderRow}>
                          <td colSpan={colCount} className={styles.groupHeaderCell}>
                            <Icon name="layer-group" size="sm" /> {svc.environment || 'Unknown'}
                          </td>
                        </tr>
                      )}
                      <tr
                        className={styles.row}
                        onClick={() => {
                          const ns = svc.namespace || '_';
                          appNavigate(
                            `services/${encodeURIComponent(ns)}/${encodeURIComponent(svc.name)}`,
                            svc.environment ? { environment: svc.environment } : undefined
                          );
                        }}
                      >
                        <td className={styles.starCell}>
                          <IconButton
                            name={isFavorite(serviceKey(svc.namespace, svc.name)) ? 'favorite' : 'star'}
                            size="md"
                            tooltip={
                              isFavorite(serviceKey(svc.namespace, svc.name))
                                ? `Remove ${svc.name} from My Apps`
                                : `Add ${svc.name} to My Apps`
                            }
                            aria-pressed={isFavorite(serviceKey(svc.namespace, svc.name))}
                            className={
                              isFavorite(serviceKey(svc.namespace, svc.name)) ? styles.starFilled : styles.starEmpty
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFavorite(serviceKey(svc.namespace, svc.name));
                            }}
                          />
                        </td>
                        <td className={styles.typeCell}>
                          <div className={styles.typeCellInner}>
                            <FrameworkBadge framework={svc.framework} />
                            {svc.isSidecar && (
                              <Tooltip content="Infrastructure sidecar (runs alongside your app in the same pod)">
                                <Badge text="sidecar" color="orange" icon="cog" />
                              </Tooltip>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className={styles.nameCell}>{svc.name}</span>
                        </td>
                        {showNsColumn && (
                          <td className={styles.nsCell}>
                            {svc.namespace ? (
                              <button
                                className={styles.nsLink}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  appNavigate(`namespaces/${encodeURIComponent(svc.namespace)}`);
                                }}
                              >
                                {svc.namespace}
                              </button>
                            ) : (
                              '—'
                            )}
                          </td>
                        )}
                        {showEnvColumn && <td className={styles.nsCell}>{svc.environment}</td>}
                        <td>
                          <div className={styles.metricCell}>
                            <span className={styles.metricValue}>
                              {formatDuration(svc.p95Duration, svc.durationUnit)}
                            </span>
                            <Sparkline
                              data={sparklineMap
                                .get(`${svc.namespace}/${svc.name}/${svc.environment ?? ''}`)
                                ?.durationSeries?.map((p) => p.v)}
                              color={sc.duration}
                            />
                          </div>
                        </td>
                        <td>
                          <div className={styles.metricCell}>
                            <span className={svc.errorRate > 0 ? styles.errorValue : styles.metricValue}>
                              {svc.errorRate.toFixed(1)}%
                            </span>
                            <Sparkline
                              data={sparklineMap
                                .get(`${svc.namespace}/${svc.name}/${svc.environment ?? ''}`)
                                ?.errorSeries?.map((p) => p.v)}
                              color={svc.errorRate > 0 ? sc.error : sc.errorDim}
                            />
                          </div>
                        </td>
                        <td>
                          <div className={styles.metricCell}>
                            <span className={styles.metricValue}>{svc.rate.toFixed(1)} req/s</span>
                            <Sparkline
                              data={sparklineMap
                                .get(`${svc.namespace}/${svc.name}/${svc.environment ?? ''}`)
                                ?.rateSeries?.map((p) => p.v)}
                              color={sc.rate}
                            />
                          </div>
                        </td>
                      </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>

            {paginated.length === 0 && showFavoritesOnly && (
              <div className={styles.emptyFavorites}>
                <Icon name="star" size="xxl" />
                <p>
                  {favCount === 0
                    ? 'No favorites yet. Click the star icon on any service to add it to My Apps.'
                    : 'No favorite services match the current filters.'}
                </p>
              </div>
            )}

            <div className={styles.footer}>
              <div className={styles.pageSize}>
                <span>Row per page:</span>
                <Combobox
                  options={PAGE_SIZE_OPTIONS}
                  value={pageSize}
                  onChange={(v) => {
                    setPageSize(v.value ?? 25);
                  }}
                  width={8}
                />
              </div>
              {totalPages > 1 && <Pagination currentPage={page} numberOfPages={totalPages} onNavigate={setPage} />}
            </div>
          </>
        )}

        {!loading && services.length === 0 && caps?.spanMetrics.detected && (
          <Alert severity="info" title="No services found">
            Span metrics are detected but no server spans were found.
          </Alert>
        )}
      </div>
    </PluginPage>
  );
}

/** Sort key for environment grouping: prod first, then dev, alphabetical within tier. */
function envSortKey(env: string): number {
  const lower = env.toLowerCase();
  if (lower === 'prod') {
    return 0;
  }
  if (lower.startsWith('prod-')) {
    return 1;
  }
  if (lower === 'dev') {
    return 2;
  }
  if (lower.startsWith('dev-')) {
    return 3;
  }
  return 4; // unknown environments last
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
    table-layout: fixed;
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
      overflow: hidden;
      text-overflow: ellipsis;
    }
    td {
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: middle;
      overflow: hidden;
      text-overflow: ellipsis;
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
  groupHeaderRow: css`
    background: ${theme.colors.background.secondary};
  `,
  groupHeaderCell: css`
    padding: ${theme.spacing(0.75)} ${theme.spacing(1.5)} !important;
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    letter-spacing: 0.5px;
    text-transform: uppercase;
    border-bottom: 1px solid ${theme.colors.border.medium} !important;
  `,
  nameCell: css`
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.link};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
  `,
  typeColHeader: css`
    width: 1%;
    white-space: nowrap;
    color: ${theme.colors.text.secondary};
    font-weight: ${theme.typography.fontWeightMedium};
    padding-right: ${theme.spacing(0.5)} !important;
  `,
  starColHeader: css`
    width: 32px;
    padding: 0 !important;
  `,
  starCell: css`
    width: 32px;
    padding: ${theme.spacing(0.5)} !important;
    text-align: center;
    vertical-align: middle;
  `,
  starFilled: css`
    color: ${theme.colors.warning.main};
  `,
  starEmpty: css`
    color: ${theme.colors.text.disabled};
    opacity: 0.4;
    transition: opacity 0.15s ease;
    tr:hover & {
      opacity: 1;
    }
  `,
  emptyFavorites: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: ${theme.spacing(6)} ${theme.spacing(2)};
    color: ${theme.colors.text.secondary};
    text-align: center;
    p {
      margin-top: ${theme.spacing(2)};
      max-width: 400px;
    }
  `,
  typeCell: css`
    width: 1%;
    white-space: nowrap;
    padding-right: ${theme.spacing(0.5)} !important;
    text-align: right;
    vertical-align: middle;
  `,
  typeCellInner: css`
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: ${theme.spacing(0.75)};
  `,
  nsCell: css`
    color: ${theme.colors.text.secondary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  metricCell: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    overflow: hidden;
  `,
  metricValue: css`
    min-width: 55px;
    flex-shrink: 0;
    text-align: left;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  `,
  errorValue: css`
    min-width: 55px;
    flex-shrink: 0;
    text-align: left;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  footer: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: ${theme.spacing(2)};
    padding: ${theme.spacing(1)} 0;
  `,
  pageSize: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});

export default ServiceInventory;
