import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { Alert, Badge, Icon, Input, LoadingPlaceholder, Pagination, Select, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { css } from '@emotion/css';
import { getServices, getCapabilities, ServiceSummary, Capabilities } from '../api/client';
import { PLUGIN_BASE_URL } from '../constants';
import { useTimeRange } from '../utils/timeRange';

const SDK_BADGES: Record<string, { text: string; color: 'blue' | 'green' | 'orange' | 'red' | 'purple' }> = {
  java: { text: 'Java', color: 'orange' },
  go: { text: 'Go', color: 'blue' },
  dotnet: { text: '.NET', color: 'purple' },
  python: { text: 'Python', color: 'blue' },
  nodejs: { text: 'Node.js', color: 'green' },
  ruby: { text: 'Ruby', color: 'red' },
  rust: { text: 'Rust', color: 'orange' },
  cpp: { text: 'C++', color: 'blue' },
  erlang: { text: 'Erlang', color: 'red' },
  php: { text: 'PHP', color: 'purple' },
};

type SortField = 'name' | 'namespace' | 'p95Duration' | 'errorRate' | 'rate';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE_OPTIONS: Array<SelectableValue<number>> = [
  { label: '10', value: 10 },
  { label: '25', value: 25 },
  { label: '50', value: 50 },
];

function ServiceInventory() {
  const styles = useStyles2(getStyles);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { fromMs, toMs } = useTimeRange();
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const namespaceFilter = searchParams.get('namespace') || '';
  const setNamespaceFilter = (ns: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (ns) {
        next.set('namespace', ns);
      } else {
        next.delete('namespace');
      }
      return next;
    }, { replace: true });
    setPage(1);
  };

  // Compute unique namespaces for the filter dropdown
  const namespaceOptions = useMemo<Array<SelectableValue<string>>>(() => {
    const nss = new Set(services.map((s) => s.namespace).filter(Boolean));
    const opts: Array<SelectableValue<string>> = [{ label: 'All namespaces', value: '' }];
    for (const ns of [...nss].sort()) {
      opts.push({ label: ns, value: ns });
    }
    return opts;
  }, [services]);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const [capsResult, servicesResult] = await Promise.all([
          getCapabilities(),
          getServices(fromMs, toMs, 60, true),
        ]);
        setCaps(capsResult);
        setServices(servicesResult);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load services');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [fromMs, toMs]);

  const filtered = useMemo(() => {
    let result = services;
    if (namespaceFilter) {
      result = result.filter((s) => s.namespace === namespaceFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) => s.name.toLowerCase().includes(q) || s.namespace.toLowerCase().includes(q)
      );
    }
    return [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'namespace': cmp = a.namespace.localeCompare(b.namespace); break;
        case 'p95Duration': cmp = a.p95Duration - b.p95Duration; break;
        case 'errorRate': cmp = a.errorRate - b.errorRate; break;
        case 'rate': cmp = a.rate - b.rate; break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [services, search, sortField, sortDir, namespaceFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
    setPage(1);
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
        {error && <Alert severity="error" title="Error">{error}</Alert>}
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
                onChange={(e) => { setSearch(e.currentTarget.value); setPage(1); }}
              />
              <Select
                options={namespaceOptions}
                value={namespaceFilter}
                onChange={(v) => setNamespaceFilter(v.value ?? '')}
                width={25}
                placeholder="All namespaces"
                isClearable
              />
            </div>

            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.sortable} onClick={() => toggleSort('name')}>
                    Name {sortIcon('name')}
                  </th>
                  <th className={styles.sortable} onClick={() => toggleSort('namespace')}>
                    Namespace {sortIcon('namespace')}
                  </th>
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
                {paginated.map((svc) => (
                  <tr
                    key={`${svc.namespace}/${svc.name}`}
                    className={styles.row}
                    onClick={() => {
                      navigate(`${PLUGIN_BASE_URL}/services/${encodeURIComponent(svc.namespace)}/${encodeURIComponent(svc.name)}`);
                    }}
                  >
                    <td>
                      <div className={styles.nameCell}>
                        <SDKIcon language={svc.sdkLanguage} />
                        <span>{svc.name}</span>
                      </div>
                    </td>
                    <td className={styles.nsCell}>{svc.namespace}</td>
                    <td>
                      <div className={styles.metricCell}>
                        <span className={styles.metricValue}>
                          {formatDuration(svc.p95Duration, svc.durationUnit)}
                        </span>
                        <AreaSparkline data={svc.durationSeries?.map((p) => p.v)} color="#E0B400" />
                      </div>
                    </td>
                    <td>
                      <div className={styles.metricCell}>
                        <span className={svc.errorRate > 0 ? styles.errorValue : styles.metricValue}>
                          {svc.errorRate.toFixed(1)}%
                        </span>
                        {svc.errorRate > 0 && <div className={styles.errorBar} />}
                        {svc.errorRate === 0 && <div className={styles.errorBarFlat} />}
                      </div>
                    </td>
                    <td>
                      <div className={styles.metricCell}>
                        <span className={styles.metricValue}>
                          {svc.rate.toFixed(1)} req/s
                        </span>
                        <AreaSparkline data={svc.rateSeries?.map((p) => p.v)} color="#73BF69" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className={styles.footer}>
              <div className={styles.pageSize}>
                <span>Row per page:</span>
                <Select
                  options={PAGE_SIZE_OPTIONS}
                  value={pageSize}
                  onChange={(v) => { setPageSize(v.value ?? 25); setPage(1); }}
                  width={8}
                />
              </div>
              {totalPages > 1 && (
                <Pagination currentPage={page} numberOfPages={totalPages} onNavigate={setPage} />
              )}
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

function SDKIcon({ language }: { language?: string }) {
  if (!language) {
    return null;
  }
  const info = SDK_BADGES[language.toLowerCase()];
  if (!info) {
    return <Badge text={language.substring(0, 4)} color="blue" />;
  }
  return <Badge text={info.text} color={info.color} />;
}

function AreaSparkline({ data, color }: { data?: number[]; color: string }) {
  if (!data || data.length < 2) {
    return <div style={{ width: 120, height: 28 }} />;
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
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polygon fill={color} fillOpacity="0.25" points={areaPoints} />
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={linePoints} />
    </svg>
  );
}

function formatDuration(value: number, unit: string): string {
  if (unit === 'ms') {
    if (value < 1) {
      return '< 1ms';
    }
    if (value >= 1000) {
      return `${(value / 1000).toFixed(1)}s`;
    }
    return `${Math.round(value)}ms`;
  }
  // seconds
  if (value < 0.001) {
    return '< 1ms';
  }
  if (value < 1) {
    return `${Math.round(value * 1000)}ms`;
  }
  return `${value.toFixed(1)}s`;
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    padding: ${theme.spacing(1)} ${theme.spacing(2)};
  `,
  toolbar: css`
    display: flex;
    gap: ${theme.spacing(1)};
    align-items: center;
    margin-bottom: ${theme.spacing(2)};
  `,
  table: css`
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    table-layout: fixed;
    th:nth-child(1) { width: 25%; }
    th:nth-child(2) { width: 12%; }
    th:nth-child(3) { width: 25%; }
    th:nth-child(4) { width: 15%; }
    th:nth-child(5) { width: 23%; }
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
  nameCell: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  nsCell: css`
    color: ${theme.colors.text.secondary};
  `,
  metricCell: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  metricValue: css`
    min-width: 70px;
    text-align: right;
    white-space: nowrap;
  `,
  errorValue: css`
    min-width: 70px;
    text-align: right;
    white-space: nowrap;
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  errorBar: css`
    width: 80px;
    height: 2px;
    background: ${theme.colors.error.main};
  `,
  errorBarFlat: css`
    width: 80px;
    height: 2px;
    background: ${theme.colors.border.weak};
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
