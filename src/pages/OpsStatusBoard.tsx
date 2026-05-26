import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
import { DataState } from '../components/DataState';
import { useOpsWatchlist, watchlistToSet, watchlistKey } from '../utils/useOpsWatchlist';
import { useUrlNumber } from '../utils/useUrlState';

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

function OpsStatusBoard() {
  const appNavigate = useAppNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const styles = useStyles2(getStyles);
  const envParam = sanitizeParam(searchParams.get('environment') ?? '');
  const envFilters = useMemo(() => (envParam ? envParam.split(',').filter(Boolean) : []), [envParam]);
  const { from, fromMs, toMs, setTimeRange } = useTimeRange();
  const { watchlist } = useOpsWatchlist();

  // Card size from URL (validated)
  const rawSize = searchParams.get('size') ?? 'md';
  const cardSize: CardSize = VALID_CARD_SIZES.has(rawSize) ? (rawSize as CardSize) : 'md';

  const [refreshInterval, setRefreshInterval] = useUrlNumber('refresh', 60000);
  const [rotationInterval, setRotationInterval] = useUrlNumber('rotation', 10000);

  // Page state that auto-resets when filters change
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

  // Viewport measurement via callback ref
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

  // Fetch ALL services (no namespace filter) — we filter to watchlist client-side
  const {
    data: fetchResult,
    loading: servicesLoading,
    error: servicesError,
    refetch,
  } = useFetch<ServiceSummary[]>(() => getServices(fromMs, toMs, 60, false), [fromMs, toMs]);

  // Fetch previous period for delta arrows (skip for sm cards)
  const isRelativeRange = from.startsWith('now');
  const rangeDuration = toMs - fromMs;
  const prevFromMs = fromMs - rangeDuration;
  const prevToMs = fromMs;
  const { data: prevServices, refetch: refetchPrev } = useFetch<ServiceSummary[]>(
    () => getServices(prevFromMs, prevToMs, 60, false),
    [prevFromMs, prevToMs],
    { skip: !isRelativeRange || cardSize === 'sm' }
  );

  // Sparklines only for lg
  const { data: sparklineResult, refetch: refetchSparklines } = useFetch<ServiceSummary[]>(
    () => getServices(fromMs, toMs, 60, true),
    [fromMs, toMs],
    { skip: !fetchResult || cardSize !== 'lg' }
  );

  // Auto-refresh
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

  // Build watchlist lookup set
  const watchlistSet = useMemo(() => watchlistToSet(watchlist), [watchlist]);

  // Filter to watchlist services and exclude sidecars
  const allServices = useMemo(() => {
    if (!fetchResult) {
      return [];
    }
    return fetchResult.filter((s) => !s.isSidecar && watchlistSet.has(watchlistKey(s.namespace, s.name)));
  }, [fetchResult, watchlistSet]);

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
      if (watchlistSet.has(watchlistKey(s.namespace, s.name))) {
        m.set(svcKey(s), s);
      }
    }
    return m;
  }, [prevServices, watchlistSet]);

  // Sparkline map
  const sparklineMap = useMemo(() => {
    if (!sparklineResult) {
      return new Map<string, ServiceSummary>();
    }
    return new Map(
      sparklineResult.filter((s) => watchlistSet.has(watchlistKey(s.namespace, s.name))).map((s) => [svcKey(s), s])
    );
  }, [sparklineResult, watchlistSet]);

  // Build the card list sorted by severity
  const cardItems = useMemo(() => {
    const items: Array<{
      service: ServiceSummary;
      status: CardStatus;
      previous?: ServiceSummary;
      sparkline?: ServiceSummary;
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

    // Sort: critical > warning > healthy, then by name
    items.sort((a, b) => {
      const severityA = healthSeverity(a.status as any);
      const severityB = healthSeverity(b.status as any);
      if (severityB !== severityA) {
        return severityB - severityA;
      }
      return a.service.name.localeCompare(b.service.name);
    });

    return items;
  }, [services, previousMap, sparklineMap]);

  // Pagination
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

  const refreshOptions = useMemo(() => REFRESH_INTERVALS.map((r) => ({ label: r.label, value: String(r.value) })), []);

  // Count services that need attention (critical/warning)
  const needsAttentionCount = useMemo(
    () => cardItems.filter((i) => i.status === 'critical' || i.status === 'warning').length,
    [cardItems]
  );

  const isEmpty = watchlist.length === 0;

  return (
    <PluginPage layout={PageLayoutType.Canvas}>
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <h2 className={styles.title}>Ops Status Board</h2>
            {needsAttentionCount > 0 && (
              <span className={styles.attentionBadge}>{needsAttentionCount} needs attention</span>
            )}
            <span className={styles.watchlistCount}>
              {watchlist.length} service{watchlist.length !== 1 ? 's' : ''} monitored
            </span>
          </div>
          <div className={styles.controls}>
            {(envOptions.length > 1 || envFilters.length > 0) && (
              <MultiCombobox
                options={envOptions}
                value={envFilters}
                onChange={(selected) => setEnvFilters(selected.map((o) => o.value).filter(Boolean) as string[])}
                placeholder="All environments"
                width={28}
              />
            )}
            <RadioButtonGroup size="sm" options={CARD_SIZE_OPTIONS} value={cardSize} onChange={(v) => setCardSize(v)} />
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
          </div>
        </div>

        <div className={styles.gridViewport} ref={gridRef}>
          {isEmpty ? (
            <div className={styles.emptyState}>
              <Icon name="monitor" size="xxxl" />
              <h3>No services configured</h3>
              <p>
                Add services to the watchlist in the <a href={`/plugins/nais-apm-app`}>plugin configuration</a> to get
                started.
              </p>
            </div>
          ) : (
            <DataState
              loading={servicesLoading}
              error={servicesError}
              errorTitle="Error loading services"
              empty={!servicesLoading && cardItems.length === 0 && !isEmpty}
              emptyTitle="No matching services"
              emptyMessage={
                envFilters.length > 0
                  ? `No watchlist services found in environment${envFilters.length > 1 ? 's' : ''} ${envFilters.join(', ')}.`
                  : 'No data available for the configured watchlist services in the selected time range.'
              }
              loadingText="Loading ops status..."
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
                    onClick={() =>
                      handleServiceClick(item.service.namespace, item.service.name, item.service.environment)
                    }
                  />
                ))}
              </div>
            </DataState>
          )}
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
  header: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1.5)} ${theme.spacing(2)} ${theme.spacing(1)};
    flex-shrink: 0;
  `,
  titleRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
  `,
  title: css`
    margin: 0;
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  attentionBadge: css`
    display: inline-flex;
    align-items: center;
    padding: ${theme.spacing(0.25)} ${theme.spacing(1)};
    border-radius: ${theme.shape.radius.pill};
    background: ${theme.colors.warning.transparent};
    color: ${theme.colors.warning.text};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  watchlistCount: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  controls: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
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
    padding: ${theme.spacing(0.5)} ${theme.spacing(2)};
    height: 100%;
    align-content: start;
  `,
  emptyState: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: ${theme.spacing(2)};
    color: ${theme.colors.text.secondary};
    text-align: center;
    padding: ${theme.spacing(4)};

    h3 {
      margin: 0;
      color: ${theme.colors.text.primary};
    }

    p {
      max-width: 400px;
    }

    a {
      color: ${theme.colors.text.link};
    }
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

export default OpsStatusBoard;
