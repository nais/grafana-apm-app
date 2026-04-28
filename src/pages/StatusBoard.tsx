import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { Combobox, Icon, MultiCombobox, RadioButtonGroup, useStyles2 } from '@grafana/ui';
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
import { StatusCard, CardStatus, CardSize, CARD_DIMENSIONS } from '../components/StatusCard';
import { PageHeader } from '../components/PageHeader';
import { DataState } from '../components/DataState';
import { useUrlNumber } from '../utils/useUrlState';

/** How long to keep showing disappeared services (30 minutes). */
const LAST_SEEN_TTL_MS = 30 * 60 * 1000;

/** Grid gap in pixels (matches theme.spacing(1.5) ≈ 12px). */
const GRID_GAP = 12;

/** Page rotation intervals. */
const ROTATION_INTERVALS = [
  { label: '5s', value: '5000' },
  { label: '10s', value: '10000' },
  { label: '15s', value: '15000' },
  { label: '30s', value: '30000' },
  { label: 'Off', value: '0' },
];

const CARD_SIZE_OPTIONS = [
  { label: 'S', value: 'sm' as const },
  { label: 'M', value: 'md' as const },
  { label: 'L', value: 'lg' as const },
];

const VALID_CARD_SIZES = new Set<string>(['sm', 'md', 'lg']);

interface LastSeenEntry {
  service: ServiceSummary;
  lastSeen: number;
}

/** Build a unique key for a service. */
function svcKey(s: ServiceSummary): string {
  return `${s.namespace}/${s.name}/${s.environment ?? ''}`;
}

/** Calculate how many cards fit in a given area. */
function calcGrid(
  containerWidth: number,
  containerHeight: number,
  size: CardSize
): { columns: number; rows: number; perPage: number } {
  const dims = CARD_DIMENSIONS[size];
  const columns = Math.max(1, Math.floor((containerWidth + GRID_GAP) / (dims.width + GRID_GAP)));
  const rows = Math.max(1, Math.floor((containerHeight + GRID_GAP) / (dims.height + GRID_GAP)));
  return { columns, rows, perPage: Math.max(1, columns * rows) };
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

  // Card size from URL (validated)
  const rawSize = searchParams.get('size') ?? 'sm';
  const cardSize: CardSize = VALID_CARD_SIZES.has(rawSize) ? (rawSize as CardSize) : 'sm';

  const [refreshInterval, setRefreshInterval] = useUrlNumber('refresh', 60000);
  const [rotationInterval, setRotationInterval] = useUrlNumber('rotation', 10000);

  // Page state that auto-resets when filters change (avoids setState-in-effect)
  const filterKey = `${envParam}|${cardSize}`;
  const [pageState, setPageState] = useState({ page: 0, filterKey });
  const currentPage = pageState.filterKey === filterKey ? pageState.page : 0;
  const setCurrentPage = useCallback(
    (pageOrUpdater: number | ((prev: number) => number)) => {
      setPageState((prev) => {
        const newPage =
          typeof pageOrUpdater === 'function'
            ? pageOrUpdater(prev.filterKey === filterKey ? prev.page : 0)
            : pageOrUpdater;
        return { page: newPage, filterKey };
      });
    },
    [filterKey]
  );

  // Viewport measurement via callback ref (works even when element mounts later)
  const [gridDims, setGridDims] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);
  const gridRef = useCallback((el: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!el) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setGridDims({
          width: Math.floor(entry.contentRect.width),
          height: Math.floor(entry.contentRect.height),
        });
      }
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  // Calculate pagination
  const { columns, perPage } = useMemo(
    () => calcGrid(gridDims.width, gridDims.height, cardSize),
    [gridDims.width, gridDims.height, cardSize]
  );

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

  // Fetch previous period for delta arrows (skip for sm cards)
  const isRelativeRange = from.startsWith('now');
  const rangeDuration = toMs - fromMs;
  const prevFromMs = fromMs - rangeDuration;
  const prevToMs = fromMs;
  const { data: prevServices, refetch: refetchPrev } = useFetch<ServiceSummary[]>(
    () => getServices(prevFromMs, prevToMs, 60, false, { namespace: decodedNs }),
    [prevFromMs, prevToMs, decodedNs],
    { skip: !isRelativeRange || cardSize === 'sm' }
  );

  // Sparklines only for lg
  const { data: sparklineResult, refetch: refetchSparklines } = useFetch<ServiceSummary[]>(
    () => getServices(fromMs, toMs, 60, true, { namespace: decodedNs }),
    [fromMs, toMs, decodedNs],
    { skip: !fetchResult || cardSize !== 'lg' }
  );

  // Auto-refresh (data)
  const handleRefresh = useCallback(() => {
    refetch();
    if (cardSize !== 'sm') {
      refetchPrev();
    }
    if (cardSize === 'lg') {
      refetchSparklines();
    }
  }, [refetch, refetchPrev, refetchSparklines, cardSize]);

  const { secondsUntilRefresh } = useAutoRefresh(handleRefresh, refreshInterval);

  // Environment options (derived from sidecar-filtered services)
  const allServices = useMemo(() => (fetchResult ?? []).filter((s) => !s.isSidecar), [fetchResult]);
  const envOptions = useMemo(() => extractEnvironmentOptions(allServices), [allServices]);

  // Apply env multi-select filter
  const services = useMemo(() => {
    if (envFilters.length === 0) {
      return allServices;
    }
    return allServices.filter((s) => s.environment != null && envFilters.includes(s.environment));
  }, [allServices, envFilters]);

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

    for (const svc of services) {
      map.set(svcKey(svc), { service: svc, lastSeen: now });
    }

    for (const [key, entry] of map) {
      if (!currentKeys.has(key) && now - entry.lastSeen > LAST_SEEN_TTL_MS) {
        map.delete(key);
      }
    }

    setLastSeenSnapshot(new Map(map));
  }, [fetchResult, services]);

  // Build the card list: current services + disappeared services (stable sort)
  const cardItems = useMemo(() => {
    const currentKeys = new Set(services.map(svcKey));
    const items: Array<{
      service: ServiceSummary;
      status: CardStatus;
      previous?: ServiceSummary;
      sparkline?: ServiceSummary;
      lastSeen?: number;
    }> = [];

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

    for (const [key, entry] of lastSeenSnapshot) {
      if (!currentKeys.has(key)) {
        items.push({
          service: entry.service,
          status: 'noData',
          lastSeen: entry.lastSeen,
        });
      }
    }

    // Sort: critical > warning > noData > healthy, then by name for stability
    items.sort((a, b) => {
      const severityA = a.status === 'noData' ? 0.5 : healthSeverity(a.status);
      const severityB = b.status === 'noData' ? 0.5 : healthSeverity(b.status);
      if (severityB !== severityA) {
        return severityB - severityA;
      }
      return a.service.name.localeCompare(b.service.name);
    });

    return items;
  }, [services, previousMap, sparklineMap, lastSeenSnapshot]);

  // Pagination (skip pagination until grid is measured)
  const isMeasured = gridDims.width > 0 && gridDims.height > 0;
  const effectivePerPage = isMeasured ? perPage : cardItems.length || 1;
  const totalPages = Math.max(1, Math.ceil(cardItems.length / effectivePerPage));
  const clampedPage = Math.min(currentPage, totalPages - 1);
  const pageItems = cardItems.slice(clampedPage * effectivePerPage, clampedPage * effectivePerPage + effectivePerPage);

  // Page rotation timer
  useEffect(() => {
    if (rotationInterval <= 0 || totalPages <= 1) {
      return;
    }
    const id = setInterval(() => {
      setCurrentPage((p) => (p + 1) % totalPages);
    }, rotationInterval);
    return () => clearInterval(id);
  }, [rotationInterval, totalPages, setCurrentPage]);

  // Pause rotation when document is hidden
  useEffect(() => {
    const handler = () => {
      if (!document.hidden && rotationInterval > 0 && totalPages > 1) {
        // On return, just let the interval continue from where it is
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [rotationInterval, totalPages]);

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

  const setCardSize = useCallback(
    (size: CardSize) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('size', size);
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
    if (envFilters.length > 0) {
      params.environment = envFilters.join(',');
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
              {(envOptions.length > 1 || envFilters.length > 0) && (
                <MultiCombobox
                  options={envOptions}
                  value={envFilters}
                  onChange={(selected) => setEnvFilters(selected.map((o) => o.value).filter(Boolean) as string[])}
                  placeholder="All environments"
                  width={28}
                />
              )}
              <RadioButtonGroup
                size="sm"
                options={CARD_SIZE_OPTIONS}
                value={cardSize}
                onChange={(v) => setCardSize(v)}
              />
              <Combobox
                options={QUICK_TIME_RANGES}
                value={from}
                onChange={(v) => setTimeRange(v?.value ?? 'now-1h', 'now')}
                width={18}
              />
              <Combobox
                options={refreshOptions}
                value={String(refreshInterval)}
                onChange={(v) => setRefreshInterval(Number(v.value))}
                width={12}
              />
              <Combobox
                options={ROTATION_INTERVALS}
                value={String(rotationInterval)}
                onChange={(v) => setRotationInterval(Number(v.value))}
                width={10}
                placeholder="Rotate"
              />
              <span className={styles.countdown}>
                <Icon name="sync" size="sm" />
                {secondsUntilRefresh}s
              </span>
            </>
          }
        />

        <div className={styles.gridViewport} ref={gridRef}>
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
            <div
              className={styles.grid}
              style={{
                gridTemplateColumns: isMeasured
                  ? `repeat(${columns}, 1fr)`
                  : `repeat(auto-fill, minmax(${CARD_DIMENSIONS[cardSize].width}px, 1fr))`,
              }}
            >
              {pageItems.map((item) => (
                <StatusCard
                  key={svcKey(item.service)}
                  service={item.service}
                  status={item.status}
                  size={cardSize}
                  previous={item.previous}
                  sparkline={item.sparkline}
                  lastSeen={item.lastSeen}
                  onClick={() =>
                    handleServiceClick(item.service.namespace, item.service.name, item.service.environment)
                  }
                />
              ))}
            </div>
          </DataState>
        </div>

        {/* Page indicator */}
        {totalPages > 1 && (
          <div className={styles.pager}>
            {Array.from({ length: totalPages }, (_, i) => (
              <button
                key={i}
                className={i === clampedPage ? styles.dotActive : styles.dot}
                onClick={() => setCurrentPage(i)}
                aria-label={`Page ${i + 1}`}
              />
            ))}
            <span className={styles.pageLabel}>
              {clampedPage + 1} / {totalPages}
            </span>
          </div>
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
    min-height: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
  `,
  gridViewport: css`
    flex: 1;
    min-height: 0;
    overflow: hidden;
    position: relative;
  `,
  grid: css`
    display: grid;
    gap: ${GRID_GAP}px;
    padding: ${theme.spacing(0.5)} 0;
    height: 100%;
    align-content: start;
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
  pager: css`
    display: flex;
    align-items: center;
    justify-content: center;
    gap: ${theme.spacing(0.75)};
    padding: ${theme.spacing(0.75)} 0;
    flex-shrink: 0;
    height: 32px;
  `,
  dot: css`
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: none;
    background: ${theme.colors.border.medium};
    cursor: pointer;
    padding: 0;
    transition: background 0.15s;
    &:hover {
      background: ${theme.colors.text.secondary};
    }
  `,
  dotActive: css`
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: none;
    background: ${theme.colors.text.link};
    cursor: pointer;
    padding: 0;
  `,
  pageLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin-left: ${theme.spacing(1)};
    font-variant-numeric: tabular-nums;
  `,
});

export default StatusBoard;
