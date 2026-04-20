import React, { useMemo, useState, useCallback } from 'react';
import { useStyles2, LoadingPlaceholder, Alert, Icon, Badge, Input, IconButton } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import {
  getEndpoints,
  getGraphQLMetrics,
  EndpointGroups,
  EndpointSummary,
  GraphQLMetricsResponse,
  GraphQLOperation,
} from '../../api/client';
import { formatDuration } from '../../utils/format';
import { useFetch } from '../../utils/useFetch';

interface ServerTabProps {
  service: string;
  namespace: string;
  fromMs: number;
  toMs: number;
}

type SortField = 'spanName' | 'rate' | 'errorRate' | 'p50Duration' | 'p95Duration' | 'p99Duration';

interface ServerData {
  endpoints: EndpointGroups;
  graphql: GraphQLMetricsResponse | null;
}

export function ServerTab({ service, namespace, fromMs, toMs }: ServerTabProps) {
  const styles = useStyles2(getStyles);
  const { data, loading, error } = useFetch<ServerData>(async () => {
    const [endpoints, graphql] = await Promise.all([
      getEndpoints(namespace, service, fromMs, toMs),
      getGraphQLMetrics(namespace, service, fromMs, toMs).catch(() => null),
    ]);
    return { endpoints, graphql };
  }, [service, namespace, fromMs, toMs]);

  if (loading) {
    return <LoadingPlaceholder text="Loading endpoints..." />;
  }

  if (error) {
    return (
      <Alert severity="error" title="Error">
        {error}
      </Alert>
    );
  }

  if (!data) {
    return null;
  }

  const { endpoints, graphql } = data;

  const hasHTTP = endpoints.http.length > 0;
  const hasGRPC = endpoints.grpc.length > 0;
  const hasDB = endpoints.database.length > 0;
  const hasMessaging = endpoints.messaging?.length > 0;
  const hasInternal = endpoints.internal.length > 0;
  const hasGraphQL = graphql?.detected === true;
  const hasAny = hasHTTP || hasGRPC || hasDB || hasMessaging || hasInternal || hasGraphQL;

  if (!hasAny) {
    return (
      <Alert severity="info" title="No endpoint data">
        No endpoint metadata found for this service. Ensure OpenTelemetry instrumentation is producing span metrics with
        HTTP, gRPC, or database attributes.
      </Alert>
    );
  }

  return (
    <div className={styles.container}>
      {hasGraphQL && graphql && (
        <>
          {graphql.operations && graphql.operations.length > 0 && (
            <GraphQLSection
              title="GraphQL Operations"
              subtitle={graphql.framework ?? ''}
              operations={graphql.operations}
            />
          )}
          {graphql.fetchers && graphql.fetchers.length > 0 && (
            <GraphQLSection title="GraphQL Resolvers" subtitle="Datafetchers" operations={graphql.fetchers} />
          )}
        </>
      )}

      {hasHTTP && (
        <EndpointSection
          title="HTTP Endpoints"
          subtitle="Inbound"
          icon="cloud"
          color="blue"
          endpoints={endpoints.http}
          durationUnit={endpoints.durationUnit}
          renderName={(ep) => (
            <span className={styles.httpEndpoint}>
              <span className={styles.httpMethod}>{ep.httpMethod}</span>
              <span>{ep.httpRoute}</span>
            </span>
          )}
        />
      )}

      {hasGRPC && (
        <EndpointSection
          title="gRPC Methods"
          subtitle="Outbound"
          icon="exchange-alt"
          color="purple"
          endpoints={endpoints.grpc}
          durationUnit={endpoints.durationUnit}
          renderName={(ep) => (
            <span className={styles.grpcEndpoint}>
              <span className={styles.grpcService}>{ep.rpcService}</span>
              <span className={styles.grpcSeparator}>/</span>
              <span>{ep.rpcMethod}</span>
            </span>
          )}
        />
      )}

      {hasDB && (
        <EndpointSection
          title="Database Operations"
          subtitle="Outbound"
          icon="database"
          color="orange"
          endpoints={endpoints.database}
          durationUnit={endpoints.durationUnit}
          renderName={(ep) => (
            <span className={styles.dbEndpoint}>
              <Badge text={ep.dbSystem ?? 'db'} color="orange" />
              <span>{ep.spanName}</span>
            </span>
          )}
        />
      )}

      {hasMessaging && (
        <EndpointSection
          title="Messaging"
          subtitle=""
          icon="envelope"
          color="purple"
          endpoints={endpoints.messaging}
          durationUnit={endpoints.durationUnit}
          renderName={(ep) => (
            <span className={styles.httpEndpoint}>
              <Badge text={ep.messagingKind ?? 'messaging'} color="purple" />
              <span>{ep.spanName}</span>
            </span>
          )}
        />
      )}

      {hasInternal && (
        <EndpointSection
          title="Internal Operations"
          subtitle=""
          icon="process"
          color="green"
          endpoints={endpoints.internal}
          durationUnit={endpoints.durationUnit}
          renderName={(ep) => <span>{ep.spanName}</span>}
        />
      )}
    </div>
  );
}

const PAGE_SIZE = 25;

function EndpointSection({
  title,
  subtitle,
  icon,
  color,
  endpoints,
  durationUnit,
  renderName,
}: {
  title: string;
  subtitle: string;
  icon: string;
  color: string;
  endpoints: EndpointSummary[];
  durationUnit: string;
  renderName: (ep: EndpointSummary) => React.ReactNode;
}) {
  const styles = useStyles2(getStyles);
  const [sortField, setSortField] = useState<SortField>('rate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [collapsed, setCollapsed] = useState(false);

  // Reset page when search changes
  const onSearch = useCallback((v: string) => {
    setSearch(v);
    setPage(0);
  }, []);

  const filtered = useMemo(() => {
    if (!search) {
      return endpoints;
    }
    const q = search.toLowerCase();
    return endpoints.filter((ep) => {
      const name = (ep.httpRoute || ep.spanName || ep.rpcMethod || '').toLowerCase();
      const method = (ep.httpMethod || '').toLowerCase();
      return name.includes(q) || method.includes(q);
    });
  }, [endpoints, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [filtered, sortField, sortDir]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paged = sorted.length > PAGE_SIZE ? sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : sorted;

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  return (
    <div className={styles.section}>
      <h4 className={styles.sectionHeader} onClick={() => setCollapsed((c) => !c)} style={{ cursor: 'pointer' }}>
        <Icon name={collapsed ? 'angle-right' : 'angle-down'} />
        <Icon name={icon as any} />
        <span>{title}</span>
        {subtitle && <span className={styles.sectionSubtitle}>({subtitle})</span>}
        <span className={styles.countBadge}>{endpoints.length}</span>
      </h4>
      {!collapsed && (
        <>
          {endpoints.length > PAGE_SIZE && (
            <div className={styles.tableControls}>
              <Input
                prefix={<Icon name="search" />}
                placeholder="Filter endpoints..."
                value={search}
                onChange={(e) => onSearch(e.currentTarget.value)}
                width={30}
              />
              {search && (
                <span className={styles.filterCount}>
                  {filtered.length} of {endpoints.length}
                </span>
              )}
              <div className={styles.pagination}>
                <span className={styles.pageInfo}>
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
                </span>
                <IconButton
                  name="angle-left"
                  aria-label="Previous page"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  size="sm"
                />
                <IconButton
                  name="angle-right"
                  aria-label="Next page"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  size="sm"
                />
              </div>
            </div>
          )}
          <table className={styles.table}>
            <thead>
              <tr>
                <SortableHeader
                  field="spanName"
                  label="Endpoint"
                  current={sortField}
                  dir={sortDir}
                  onSort={toggleSort}
                />
                <SortableHeader
                  field="rate"
                  label="Rate"
                  current={sortField}
                  dir={sortDir}
                  onSort={toggleSort}
                  align="right"
                />
                <SortableHeader
                  field="errorRate"
                  label="Error %"
                  current={sortField}
                  dir={sortDir}
                  onSort={toggleSort}
                  align="right"
                />
                <SortableHeader
                  field="p50Duration"
                  label="P50"
                  current={sortField}
                  dir={sortDir}
                  onSort={toggleSort}
                  align="right"
                />
                <SortableHeader
                  field="p95Duration"
                  label="P95"
                  current={sortField}
                  dir={sortDir}
                  onSort={toggleSort}
                  align="right"
                />
                <SortableHeader
                  field="p99Duration"
                  label="P99"
                  current={sortField}
                  dir={sortDir}
                  onSort={toggleSort}
                  align="right"
                />
              </tr>
            </thead>
            <tbody>
              {paged.map((ep) => (
                <tr key={ep.spanName}>
                  <td className={styles.nameCell}>{renderName(ep)}</td>
                  <td className={styles.numCell}>{ep.rate.toFixed(2)} req/s</td>
                  <td className={ep.errorRate > 0 ? styles.errorCell : styles.numCell}>{ep.errorRate.toFixed(1)}%</td>
                  <td className={styles.numCell}>{formatDuration(ep.p50Duration, durationUnit)}</td>
                  <td className={styles.numCell}>{formatDuration(ep.p95Duration, durationUnit)}</td>
                  <td className={styles.numCell}>{formatDuration(ep.p99Duration, durationUnit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.length > PAGE_SIZE && (
            <div className={styles.bottomPagination}>
              <span className={styles.pageInfo}>
                Page {page + 1} of {totalPages}
              </span>
              <IconButton
                name="angle-left"
                aria-label="Previous page"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                size="sm"
              />
              <IconButton
                name="angle-right"
                aria-label="Next page"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                size="sm"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SortableHeader({
  field,
  label,
  current,
  dir,
  onSort,
  align = 'left',
}: {
  field: SortField;
  label: string;
  current: SortField;
  dir: 'asc' | 'desc';
  onSort: (f: SortField) => void;
  align?: 'left' | 'right';
}) {
  const styles = useStyles2(getStyles);
  const cls = align === 'right' ? styles.sortableHeaderRight : styles.sortableHeader;
  return (
    <th className={cls} onClick={() => onSort(field)}>
      {label} {current === field && <Icon name={dir === 'asc' ? 'arrow-up' : 'arrow-down'} size="sm" />}
    </th>
  );
}

type GQLSortField = 'name' | 'rate' | 'errorRate' | 'avgLatency';

function GraphQLSection({
  title,
  subtitle,
  operations,
}: {
  title: string;
  subtitle: string;
  operations: GraphQLOperation[];
}) {
  const styles = useStyles2(getStyles);
  const [sortField, setSortField] = useState<GQLSortField>('rate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [collapsed, setCollapsed] = useState(false);

  const onSearch = useCallback((v: string) => {
    setSearch(v);
    setPage(0);
  }, []);

  const filtered = useMemo(() => {
    if (!search) {
      return operations;
    }
    const q = search.toLowerCase();
    return operations.filter((op) => {
      return op.name.toLowerCase().includes(q) || (op.type ?? '').toLowerCase().includes(q);
    });
  }, [operations, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sortField) {
        case 'name':
          av = a.name;
          bv = b.name;
          break;
        case 'rate':
          av = a.rate;
          bv = b.rate;
          break;
        case 'errorRate':
          av = a.errorRate ?? -1;
          bv = b.errorRate ?? -1;
          break;
        case 'avgLatency':
          av = a.avgLatency;
          bv = b.avgLatency;
          break;
        default:
          av = a.rate;
          bv = b.rate;
      }
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [filtered, sortField, sortDir]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paged = sorted.length > PAGE_SIZE ? sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : sorted;

  const toggleSort = (field: GQLSortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const gqlSortIcon = (field: GQLSortField) => {
    if (sortField !== field) {
      return null;
    }
    return <Icon name={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'} size="sm" />;
  };

  const hasType = operations.some((op) => op.type);

  return (
    <div className={styles.section}>
      <h4 className={styles.sectionHeader} onClick={() => setCollapsed((c) => !c)} style={{ cursor: 'pointer' }}>
        <Icon name={collapsed ? 'angle-right' : 'angle-down'} />
        <Icon name="graph-bar" />
        <span>{title}</span>
        {subtitle && <span className={styles.sectionSubtitle}>({subtitle})</span>}
        <span className={styles.countBadge}>{operations.length}</span>
      </h4>
      {!collapsed && (
        <>
          {operations.length > PAGE_SIZE && (
            <div className={styles.tableControls}>
              <Input
                prefix={<Icon name="search" />}
                placeholder="Filter operations..."
                value={search}
                onChange={(e) => onSearch(e.currentTarget.value)}
                width={30}
              />
              {search && (
                <span className={styles.filterCount}>
                  {filtered.length} of {operations.length}
                </span>
              )}
              <div className={styles.pagination}>
                <span className={styles.pageInfo}>
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
                </span>
                <IconButton
                  name="angle-left"
                  aria-label="Previous page"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  size="sm"
                />
                <IconButton
                  name="angle-right"
                  aria-label="Next page"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  size="sm"
                />
              </div>
            </div>
          )}
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.sortableHeader} onClick={() => toggleSort('name')}>
                  Operation {gqlSortIcon('name')}
                </th>
                {hasType && <th>Type</th>}
                <th className={styles.sortableHeaderRight} onClick={() => toggleSort('rate')}>
                  Rate {gqlSortIcon('rate')}
                </th>
                <th className={styles.sortableHeaderRight} onClick={() => toggleSort('errorRate')}>
                  Error % {gqlSortIcon('errorRate')}
                </th>
                <th className={styles.sortableHeaderRight} onClick={() => toggleSort('avgLatency')}>
                  Avg Latency {gqlSortIcon('avgLatency')}
                </th>
              </tr>
            </thead>
            <tbody>
              {paged.map((op) => (
                <tr key={op.name + (op.type ?? '')}>
                  <td className={styles.nameCell}>
                    <span className={styles.gqlOpName}>{op.name}</span>
                  </td>
                  {hasType && (
                    <td>
                      {op.type && (
                        <Badge text={op.type.toUpperCase()} color={op.type === 'mutation' ? 'orange' : 'blue'} />
                      )}
                    </td>
                  )}
                  <td className={styles.numCell}>{op.rate.toFixed(2)} req/s</td>
                  <td className={op.errorRate != null && op.errorRate > 0 ? styles.errorCell : styles.numCell}>
                    {op.errorRate != null ? `${op.errorRate.toFixed(1)}%` : '—'}
                  </td>
                  <td className={styles.numCell}>{formatDuration(op.avgLatency, op.latencyUnit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.length > PAGE_SIZE && (
            <div className={styles.bottomPagination}>
              <span className={styles.pageInfo}>
                Page {page + 1} of {totalPages}
              </span>
              <IconButton
                name="angle-left"
                aria-label="Previous page"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                size="sm"
              />
              <IconButton
                name="angle-right"
                aria-label="Next page"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                size="sm"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(3)};
  `,
  section: css`
    display: flex;
    flex-direction: column;
  `,
  sectionHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    margin-bottom: ${theme.spacing(1)};
    color: ${theme.colors.text.primary};
  `,
  sectionSubtitle: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: normal;
  `,
  countBadge: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: 10px;
    background: ${theme.colors.background.secondary};
    color: ${theme.colors.text.secondary};
    font-size: 11px;
    font-weight: ${theme.typography.fontWeightMedium};
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
    }
    td {
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: middle;
    }
    tr:hover {
      background: ${theme.colors.background.secondary};
    }
  `,
  sortableHeader: css`
    cursor: pointer;
    user-select: none;
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
  sortableHeaderRight: css`
    cursor: pointer;
    user-select: none;
    &:hover {
      color: ${theme.colors.text.primary};
    }
    && {
      text-align: right;
    }
  `,
  nameCell: css`
    font-weight: ${theme.typography.fontWeightMedium};
    max-width: 400px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  numCell: css`
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  `,
  errorCell: css`
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  httpEndpoint: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  httpMethod: css`
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: ${theme.typography.fontWeightBold};
    font-family: ${theme.typography.fontFamilyMonospace};
    background: ${theme.colors.info.transparent};
    color: ${theme.colors.info.text};
    letter-spacing: 0.3px;
  `,
  grpcEndpoint: css`
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  grpcService: css`
    color: ${theme.colors.text.secondary};
  `,
  grpcSeparator: css`
    color: ${theme.colors.text.disabled};
  `,
  dbEndpoint: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  gqlOpName: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  tableControls: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    margin-bottom: ${theme.spacing(1)};
    flex-wrap: wrap;
  `,
  filterCount: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  pagination: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    margin-left: auto;
  `,
  pageInfo: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    white-space: nowrap;
  `,
  bottomPagination: css`
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(1)} 0;
  `,
});
