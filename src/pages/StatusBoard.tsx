import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { Combobox, Icon, MultiCombobox, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2, PageLayoutType } from '@grafana/data';
import { css } from '@emotion/css';
import { getServices, ServiceSummary } from '../api/client';
import { useTimeRange } from '../utils/timeRange';
import { QUICK_TIME_RANGES } from '../utils/timeRangeOptions';
import { useAppNavigate, sanitizeParam } from '../utils/navigation';
import { extractEnvironmentOptions } from '../utils/options';
import { useFetch } from '../utils/useFetch';
import { getServiceHealth, healthSeverity } from '../utils/health';
import { useAutoRefresh, REFRESH_INTERVALS } from '../utils/useInterval';
import { StatusCard, CardStatus } from '../components/StatusCard';
import { PageHeader } from '../components/PageHeader';
import { DataState } from '../components/DataState';

/** How long to keep showing disappeared services (30 minutes). */
const LAST_SEEN_TTL_MS = 30 * 60 * 1000;

interface LastSeenEntry {
  service: ServiceSummary;
  lastSeen: number;
}

/** Build a unique key for a service. */
function svcKey(s: ServiceSummary): string {
  return `${s.namespace}/${s.name}/${s.environment ?? ''}`;
}

function StatusBoard() {
  const { namespace = '' } = useParams<{ namespace: string }>();
  const decodedNs = decodeURIComponent(namespace);
  const appNavigate = useAppNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const styles = useStyles2(getStyles);
  const envParam = sanitizeParam(searchParams.get('environment') ?? '');
  const envFilters = useMemo(() => (envParam ? envParam.split(',').filter(Boolean) : []), [envParam]);
  const { from, fromMs, toMs, setTimeRange } = useTimeRange();

  const [refreshInterval, setRefreshInterval] = useState(60000);

  // Fetch all services for the namespace (filter by env client-side for multi-select)
  const {
    data: fetchResult,
    loading: servicesLoading,
    error: servicesError,
    refetch,
  } = useFetch<ServiceSummary[]>(
    () => getServices(fromMs, toMs, 60, false, { namespace: decodedNs }),
    [fromMs, toMs, decodedNs]
  );

  // Fetch previous period for delta arrows
  const isRelativeRange = from.startsWith('now');
  const rangeDuration = toMs - fromMs;
  const prevFromMs = fromMs - rangeDuration;
  const prevToMs = fromMs;
  const { data: prevServices, refetch: refetchPrev } = useFetch<ServiceSummary[]>(
    () => getServices(prevFromMs, prevToMs, 60, false, { namespace: decodedNs }),
    [prevFromMs, prevToMs, decodedNs],
    { skip: !isRelativeRange }
  );

  // Lazy-load sparklines (fetch all, filter client-side)
  const { data: sparklineResult, refetch: refetchSparklines } = useFetch<ServiceSummary[]>(
    () => getServices(fromMs, toMs, 60, true, { namespace: decodedNs }),
    [fromMs, toMs, decodedNs],
    { skip: !fetchResult }
  );

  // Auto-refresh
  const handleRefresh = useCallback(() => {
    refetch();
    refetchPrev();
    refetchSparklines();
  }, [refetch, refetchPrev, refetchSparklines]);

  const { secondsUntilRefresh } = useAutoRefresh(handleRefresh, refreshInterval);

  // Environment options (derived from fetched services)
  const envOptions = useMemo(() => extractEnvironmentOptions(fetchResult ?? []), [fetchResult]);

  // Filter out sidecars, then apply env multi-select filter
  const services = useMemo(() => {
    const all = (fetchResult ?? []).filter((s) => !s.isSidecar);
    if (envFilters.length === 0) {
      return all;
    }
    return all.filter((s) => s.environment && envFilters.includes(s.environment));
  }, [fetchResult, envFilters]);

  // Previous-period map
  const previousMap = useMemo(() => {
    if (!prevServices) {
      return undefined;
    }
    const m = new Map<string, ServiceSummary>();
    for (const s of prevServices) {
      m.set(svcKey(s), s);
    }
    return m;
  }, [prevServices]);

  // Sparkline map
  const sparklineMap = useMemo(() => {
    if (!sparklineResult) {
      return new Map<string, ServiceSummary>();
    }
    return new Map(sparklineResult.map((s) => [svcKey(s), s]));
  }, [sparklineResult]);

  // "Last seen" tracking for disappeared services
  const lastSeenRef = useRef<Map<string, LastSeenEntry>>(new Map());
  const [lastSeenSnapshot, setLastSeenSnapshot] = useState<Map<string, LastSeenEntry>>(new Map());

  useEffect(() => {
    if (!fetchResult) {
      return;
    }

    const now = Date.now();
    const currentKeys = new Set(services.map(svcKey));
    const map = lastSeenRef.current;

    // Update lastSeen for all current services
    for (const svc of services) {
      map.set(svcKey(svc), { service: svc, lastSeen: now });
    }

    // Prune entries older than TTL
    for (const [key, entry] of map) {
      if (!currentKeys.has(key) && now - entry.lastSeen > LAST_SEEN_TTL_MS) {
        map.delete(key);
      }
    }

    // Trigger re-render with snapshot
    setLastSeenSnapshot(new Map(map));
  }, [fetchResult, services]);

  // Build the card list: current services + disappeared services
  const cardItems = useMemo(() => {
    const currentKeys = new Set(services.map(svcKey));
    const items: Array<{
      service: ServiceSummary;
      status: CardStatus;
      previous?: ServiceSummary;
      sparkline?: ServiceSummary;
      lastSeen?: number;
    }> = [];

    // Current services
    for (const svc of services) {
      const key = svcKey(svc);
      const health = getServiceHealth(svc.errorRate, svc.p95Duration, svc.durationUnit);
      items.push({
        service: svc,
        status: health,
        previous: previousMap?.get(key),
        sparkline: sparklineMap.get(key),
      });
    }

    // Disappeared services
    for (const [key, entry] of lastSeenSnapshot) {
      if (!currentKeys.has(key)) {
        items.push({
          service: entry.service,
          status: 'noData',
          lastSeen: entry.lastSeen,
        });
      }
    }

    // Sort: critical > warning > noData > healthy, then by error rate desc
    items.sort((a, b) => {
      const severityA = a.status === 'noData' ? 0.5 : healthSeverity(a.status);
      const severityB = b.status === 'noData' ? 0.5 : healthSeverity(b.status);
      if (severityB !== severityA) {
        return severityB - severityA;
      }
      return b.service.errorRate - a.service.errorRate;
    });

    return items;
  }, [services, previousMap, sparklineMap, lastSeenSnapshot]);

  const setEnvFilters = useCallback(
    (envs: string[]) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (envs.length > 0) {
            next.set('environment', envs.join(','));
          } else {
            next.delete('environment');
          }
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const handleServiceClick = useCallback(
    (ns: string, svc: string, env?: string) => {
      appNavigate(
        `services/${encodeURIComponent(ns || '_')}/${encodeURIComponent(svc)}`,
        env ? { environment: env } : undefined
      );
    },
    [appNavigate]
  );

  const handleBack = useCallback(() => {
    const params: Record<string, string> = {};
    if (envFilters.length === 1) {
      params.environment = envFilters[0];
    }
    appNavigate(`namespaces/${encodeURIComponent(decodedNs)}`, Object.keys(params).length > 0 ? params : undefined);
  }, [appNavigate, decodedNs, envFilters]);

  const refreshOptions = useMemo(() => REFRESH_INTERVALS.map((r) => ({ label: r.label, value: String(r.value) })), []);

  return (
    <PluginPage layout={PageLayoutType.Canvas}>
      <div className={styles.container}>
        <PageHeader
          title={`${decodedNs} — Status Board`}
          backLabel="Namespace"
          onBack={handleBack}
          controls={
            <>
              {envOptions.length > 1 && (
                <MultiCombobox
                  options={envOptions}
                  value={envFilters}
                  onChange={(selected) => setEnvFilters(selected.map((o) => o.value ?? ''))}
                  placeholder="All environments"
                  width={28}
                />
              )}
              <Combobox
                options={QUICK_TIME_RANGES}
                value={from}
                onChange={(v) => setTimeRange(v?.value ?? 'now-1h', 'now')}
                width={22}
              />
              <Combobox
                options={refreshOptions}
                value={String(refreshInterval)}
                onChange={(v) => setRefreshInterval(Number(v.value))}
                width={14}
              />
              <span className={styles.countdown}>
                <Icon name="sync" size="sm" />
                {secondsUntilRefresh}s
              </span>
            </>
          }
        />

        <DataState
          loading={servicesLoading}
          error={servicesError}
          errorTitle="Error loading services"
          empty={!servicesLoading && cardItems.length === 0}
          emptyTitle="No services found"
          emptyMessage={
            <>
              No services found for namespace <strong>{decodedNs}</strong>
              {envFilters.length > 0
                ? ` in environment${envFilters.length > 1 ? 's' : ''} ${envFilters.join(', ')}`
                : ''}
              .
            </>
          }
          loadingText="Loading status board..."
        >
          <div className={styles.grid}>
            {cardItems.map((item) => (
              <StatusCard
                key={svcKey(item.service)}
                service={item.service}
                status={item.status}
                previous={item.previous}
                sparkline={item.sparkline}
                lastSeen={item.lastSeen}
                onClick={() => handleServiceClick(item.service.namespace, item.service.name, item.service.environment)}
              />
            ))}
          </div>
        </DataState>
      </div>
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 0;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: ${theme.spacing(2)};
    padding: ${theme.spacing(0.5)} 0;
  `,
  countdown: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
    min-width: 48px;
  `,
});

export default StatusBoard;
