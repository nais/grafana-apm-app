import React, { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import {
  Alert,
  Badge,
  Icon,
  InlineSwitch,
  Input,
  LoadingPlaceholder,
  Pagination,
  Select,
  Tooltip,
  useStyles2,
} from '@grafana/ui';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { css } from '@emotion/css';
import { getServices, getCapabilities, ServiceSummary, Capabilities } from '../api/client';
import { useTimeRange } from '../utils/timeRange';
import { useAppNavigate, sanitizeParam } from '../utils/navigation';
import { formatDuration } from '../utils/format';
import { useFetch } from '../utils/useFetch';

const FRAMEWORK_BADGES: Record<string, { text: string; color: 'blue' | 'green' | 'orange' | 'red' | 'purple' }> = {
  Ktor: { text: 'Ktor', color: 'purple' },
  'Spring Boot': { text: 'Spring', color: 'green' },
  'Node.js': { text: 'Node.js', color: 'orange' },
  Go: { text: 'Go', color: 'blue' },
};

type SortField = 'name' | 'namespace' | 'environment' | 'p95Duration' | 'errorRate' | 'rate';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE_OPTIONS: Array<SelectableValue<number>> = [
  { label: '10', value: 10 },
  { label: '25', value: 25 },
  { label: '50', value: 50 },
];

const TIME_RANGE_OPTIONS: Array<SelectableValue<string>> = [
  { label: 'Last 15 minutes', value: 'now-15m' },
  { label: 'Last 30 minutes', value: 'now-30m' },
  { label: 'Last 1 hour', value: 'now-1h' },
  { label: 'Last 3 hours', value: 'now-3h' },
  { label: 'Last 6 hours', value: 'now-6h' },
  { label: 'Last 12 hours', value: 'now-12h' },
  { label: 'Last 24 hours', value: 'now-24h' },
];

function ServiceInventory() {
  const styles = useStyles2(getStyles);
  const appNavigate = useAppNavigate();
  const { from, fromMs, toMs, setTimeRange } = useTimeRange();
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
  const namespaceFilter = searchParams.get('namespace') ?? '';
  const rawEnvFilter = searchParams.get('environment') ?? '';
  const envFilter = sanitizeParam(rawEnvFilter);
  const search = searchParams.get('q') ?? '';
  const hideSidecars = searchParams.get('hideSidecars') !== 'false'; // default: true
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

  const setNamespaceFilter = (ns: string) => updateParams({ namespace: ns || null, page: null });
  const setEnvFilter = (env: string) => updateParams({ environment: env || null, page: null });
  const setSearch = (q: string) => updateParams({ q: q || null, page: null });
  const setPage = (p: number) => updateParams({ page: p > 1 ? String(p) : null });
  const setPageSize = (sz: number) => updateParams({ pageSize: sz !== 25 ? String(sz) : null, page: null });

  // Compute unique namespaces for the filter dropdown
  const namespaceOptions = useMemo<Array<SelectableValue<string>>>(() => {
    const nss = new Set(services.map((s) => s.namespace).filter(Boolean));
    const opts: Array<SelectableValue<string>> = [];
    for (const ns of [...nss].sort()) {
      opts.push({ label: ns, value: ns });
    }
    return opts;
  }, [services]);

  // Compute unique environments for the filter dropdown
  const envOptions = useMemo<Array<SelectableValue<string>>>(() => {
    const envs = new Set(services.map((s) => s.environment).filter(Boolean));
    const opts: Array<SelectableValue<string>> = [];
    for (const e of [...envs].sort()) {
      opts.push({ label: e, value: e });
    }
    return opts;
  }, [services]);

  // Client-side filtering and sorting — computed every render to avoid
  // stale-closure issues with React 18 batching.
  let filtered = services;
  if (hideSidecars) {
    filtered = filtered.filter((s) => !s.isSidecar);
  }
  if (namespaceFilter) {
    filtered = filtered.filter((s) => s.namespace === namespaceFilter);
  }
  if (envFilter) {
    filtered = filtered.filter((s) => s.environment === envFilter);
  }
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter((s) => s.name.toLowerCase().includes(q) || s.namespace.toLowerCase().includes(q));
  }
  // NaN-safe numeric comparison — NaN/undefined/Infinity sort to bottom
  const safeNum = (v: number) => (Number.isFinite(v) ? v : -Infinity);
  const dir = sortDir === 'desc' ? -1 : 1;
  filtered = [...filtered].sort((a, b) => {
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
  const groupByEnv = !!namespaceFilter && !envFilter && envOptions.length > 1;

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
  const showNsColumn = !namespaceFilter;
  // Show environment column only when there are multiple envs, no env filter, and not grouping
  const showEnvColumn = envOptions.length > 1 && !envFilter && !groupByEnv;

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
              <Input
                prefix={<Icon name="search" />}
                placeholder="Filter services..."
                width={30}
                value={search}
                onChange={(e) => {
                  setSearch(e.currentTarget.value);
                }}
              />
              <Select
                options={namespaceOptions}
                value={namespaceFilter || null}
                onChange={(v) => setNamespaceFilter(v?.value ?? '')}
                width={25}
                placeholder="All namespaces"
                isClearable
              />
              {envOptions.length > 1 && (
                <Select
                  options={envOptions}
                  value={envFilter || null}
                  onChange={(v) => setEnvFilter(v?.value ?? '')}
                  width={20}
                  placeholder="All environments"
                  isClearable
                />
              )}
              <div className={styles.toolbarSpacer} />
              <Tooltip content="Hide infrastructure sidecars (wonderwall, texas) from the list">
                <InlineSwitch
                  label="Hide sidecars"
                  showLabel
                  value={hideSidecars}
                  onChange={() => updateParams({ hideSidecars: hideSidecars ? 'false' : null, page: null })}
                />
              </Tooltip>
              <Select
                options={TIME_RANGE_OPTIONS}
                value={from}
                onChange={(v) => setTimeRange(v?.value ?? 'now-1h', 'now')}
                width={22}
                prefix={<Icon name="clock-nine" />}
              />
            </div>

            <table className={styles.table}>
              <colgroup>
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
                  const colCount = 5 + (showNsColumn ? 1 : 0) + (showEnvColumn ? 1 : 0);
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
                        <td className={styles.typeCell}>
                          <div className={styles.typeCellInner}>
                            <FrameworkBadge framework={svc.framework} />
                            {svc.isSidecar && (
                              <Tooltip content="Infrastructure sidecar (runs alongside your app in the same pod)">
                                <Badge text="sidecar" color="orange" icon="cog" />
                              </Tooltip>
                            )}
                            {svc.hasFrontend && (
                              <span className={styles.faroBadge} title="Faro Web SDK">
                                🌐
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className={styles.nameCell}>{svc.name}</span>
                        </td>
                        {showNsColumn && <td className={styles.nsCell}>{svc.namespace}</td>}
                        {showEnvColumn && <td className={styles.nsCell}>{svc.environment}</td>}
                        <td>
                          <div className={styles.metricCell}>
                            <span className={styles.metricValue}>
                              {svc.hasServerSpans !== false ? formatDuration(svc.p95Duration, svc.durationUnit) : '—'}
                            </span>
                            {svc.hasServerSpans !== false && (
                              <AreaSparkline
                                data={sparklineMap
                                  .get(`${svc.namespace}/${svc.name}/${svc.environment ?? ''}`)
                                  ?.durationSeries?.map((p) => p.v)}
                                color="#E0B400"
                              />
                            )}
                          </div>
                        </td>
                        <td>
                          <div className={styles.metricCell}>
                            <span className={svc.errorRate > 0 ? styles.errorValue : styles.metricValue}>
                              {svc.hasServerSpans !== false ? `${svc.errorRate.toFixed(1)}%` : '—'}
                            </span>
                            {svc.hasServerSpans !== false && (
                              <AreaSparkline
                                data={sparklineMap
                                  .get(`${svc.namespace}/${svc.name}/${svc.environment ?? ''}`)
                                  ?.errorSeries?.map((p) => p.v)}
                                color={svc.errorRate > 0 ? '#F2495C' : '#44444480'}
                              />
                            )}
                          </div>
                        </td>
                        <td>
                          <div className={styles.metricCell}>
                            <span className={styles.metricValue}>
                              {svc.hasServerSpans !== false ? `${svc.rate.toFixed(1)} req/s` : '—'}
                            </span>
                            {svc.hasServerSpans !== false && (
                              <AreaSparkline
                                data={sparklineMap
                                  .get(`${svc.namespace}/${svc.name}/${svc.environment ?? ''}`)
                                  ?.rateSeries?.map((p) => p.v)}
                                color="#73BF69"
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>

            <div className={styles.footer}>
              <div className={styles.pageSize}>
                <span>Row per page:</span>
                <Select
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

function FrameworkBadge({ framework }: { framework?: string }) {
  if (!framework) {
    return null;
  }
  const info = FRAMEWORK_BADGES[framework];
  if (!info) {
    return <Badge text={framework} color="blue" />;
  }
  return <Badge text={info.text} color={info.color} />;
}

function AreaSparkline({ data, color }: { data?: number[]; color: string }) {
  if (!data || data.length < 2) {
    return <div style={{ width: '100%', maxWidth: 120, height: 28, flexShrink: 1 }} />;
  }
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 120;
  const h = 28;
  const pad = 1;

  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - 2 * pad);
    const y = pad + (1 - (v - min) / range) * (h - 2 * pad);
    return `${x},${y}`;
  });

  const linePoints = points.join(' ');
  const areaPoints = `${pad},${h} ${linePoints} ${w - pad},${h}`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: '100%', maxWidth: 120, height: 28, flexShrink: 1, display: 'block' }}
      preserveAspectRatio="none"
    >
      <polygon fill={color} fillOpacity="0.25" points={areaPoints} />
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={linePoints} />
    </svg>
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
    gap: ${theme.spacing(1)};
    align-items: center;
    margin-bottom: ${theme.spacing(2)};
  `,
  toolbarSpacer: css`
    flex: 1;
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
    width: 120px;
    max-width: 120px;
    color: ${theme.colors.text.secondary};
    font-weight: ${theme.typography.fontWeightMedium};
    padding-right: ${theme.spacing(0.5)} !important;
  `,
  typeCell: css`
    width: 120px;
    max-width: 120px;
    min-width: 120px;
    padding-right: ${theme.spacing(0.5)} !important;
    text-align: right;
    white-space: nowrap;
    vertical-align: middle;
  `,
  typeCellInner: css`
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: ${theme.spacing(0.75)};
  `,
  faroBadge: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px 6px;
    border-radius: 4px;
    font-size: 14px;
    line-height: 1;
    height: 22px;
    box-sizing: border-box;
    background: ${theme.colors.info.transparent};
    border: 1px solid ${theme.colors.info.border};
    color: ${theme.colors.info.text};
  `,
  nsCell: css`
    color: ${theme.colors.text.secondary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
