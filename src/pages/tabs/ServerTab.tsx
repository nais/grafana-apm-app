import React, { useEffect, useMemo, useState } from 'react';
import { useStyles2, LoadingPlaceholder, Alert, Icon, Badge } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getEndpoints, EndpointGroups, EndpointSummary } from '../../api/client';
import { formatDuration } from '../../utils/format';

interface ServerTabProps {
  service: string;
  namespace: string;
  fromMs: number;
  toMs: number;
}

type SortField = 'spanName' | 'rate' | 'errorRate' | 'p50Duration' | 'p95Duration' | 'p99Duration';

export function ServerTab({ service, namespace, fromMs, toMs }: ServerTabProps) {
  const styles = useStyles2(getStyles);
  const [endpoints, setEndpoints] = useState<EndpointGroups | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetch = async () => {
      try {
        setError(null);
        setLoading(true);
        const data = await getEndpoints(namespace, service, fromMs, toMs);
        setEndpoints(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load endpoints');
      } finally {
        setLoading(false);
      }
    };
    fetch();
  }, [service, namespace, fromMs, toMs]);

  if (loading) {
    return <LoadingPlaceholder text="Loading endpoints..." />;
  }

  if (error) {
    return <Alert severity="error" title="Error">{error}</Alert>;
  }

  if (!endpoints) {
    return null;
  }

  const hasHTTP = endpoints.http.length > 0;
  const hasGRPC = endpoints.grpc.length > 0;
  const hasDB = endpoints.database.length > 0;
  const hasInternal = endpoints.internal.length > 0;
  const hasAny = hasHTTP || hasGRPC || hasDB || hasInternal;

  if (!hasAny) {
    return (
      <Alert severity="info" title="No endpoint data">
        No endpoint metadata found for this service. Ensure OpenTelemetry instrumentation
        is producing span metrics with HTTP, gRPC, or database attributes.
      </Alert>
    );
  }

  return (
    <div className={styles.container}>
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

  const sorted = useMemo(() => {
    return [...endpoints].sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [endpoints, sortField, sortDir]);

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
      <h4 className={styles.sectionHeader}>
        <Icon name={icon as any} />
        <span>{title}</span>
        {subtitle && <span className={styles.sectionSubtitle}>({subtitle})</span>}
        <span className={styles.countBadge}>{endpoints.length}</span>
      </h4>
      <table className={styles.table}>
        <thead>
          <tr>
            <SortableHeader field="spanName" label="Endpoint" current={sortField} dir={sortDir} onSort={toggleSort} />
            <SortableHeader field="rate" label="Rate" current={sortField} dir={sortDir} onSort={toggleSort} />
            <SortableHeader field="errorRate" label="Error %" current={sortField} dir={sortDir} onSort={toggleSort} />
            <SortableHeader field="p50Duration" label="P50" current={sortField} dir={sortDir} onSort={toggleSort} />
            <SortableHeader field="p95Duration" label="P95" current={sortField} dir={sortDir} onSort={toggleSort} />
            <SortableHeader field="p99Duration" label="P99" current={sortField} dir={sortDir} onSort={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((ep) => (
            <tr key={ep.spanName}>
              <td className={styles.nameCell}>{renderName(ep)}</td>
              <td className={styles.numCell}>{ep.rate.toFixed(2)} req/s</td>
              <td className={ep.errorRate > 0 ? styles.errorCell : styles.numCell}>
                {ep.errorRate.toFixed(1)}%
              </td>
              <td className={styles.numCell}>{formatDuration(ep.p50Duration, durationUnit)}</td>
              <td className={styles.numCell}>{formatDuration(ep.p95Duration, durationUnit)}</td>
              <td className={styles.numCell}>{formatDuration(ep.p99Duration, durationUnit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortableHeader({
  field,
  label,
  current,
  dir,
  onSort,
}: {
  field: SortField;
  label: string;
  current: SortField;
  dir: 'asc' | 'desc';
  onSort: (f: SortField) => void;
}) {
  const styles = useStyles2(getStyles);
  return (
    <th className={styles.sortableHeader} onClick={() => onSort(field)}>
      {label} {current === field && <Icon name={dir === 'asc' ? 'arrow-up' : 'arrow-down'} size="sm" />}
    </th>
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
    table-layout: fixed;
    th:nth-child(1) { width: 40%; }
    th {
      text-align: left;
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      color: ${theme.colors.text.secondary};
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      border-bottom: 1px solid ${theme.colors.border.medium};
      white-space: nowrap;
    }
    th:nth-child(n+2) { width: 12%; text-align: right; }
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
});
