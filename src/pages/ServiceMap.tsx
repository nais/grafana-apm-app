import React, { useCallback, useMemo } from 'react';
import { PluginPage } from '@grafana/runtime';
import { useStyles2, RadioButtonGroup, Combobox, Tooltip, Icon } from '@grafana/ui';
import { GrafanaTheme2, PageLayoutType } from '@grafana/data';
import { css } from '@emotion/css';
import { useSearchParams } from 'react-router-dom';
import { getServiceMap, ServiceMapResponse } from '../api/client';
import { getClusteredServiceMap, ClusteredServiceMapResponse, totalClusteredServices } from '../api/servicemap';
import { useTimeRange } from '../utils/timeRange';
import { QUICK_TIME_RANGES } from '../utils/timeRangeOptions';
import { useAppNavigate, sanitizeParam } from '../utils/navigation';
import { useUrlParams } from '../utils/useUrlState';
import { useConfiguredEnvironments } from '../utils/datasources';
import { useFetch } from '../utils/useFetch';
import { ServiceGraph, toGraphData } from '../components/ServiceGraph';
import { CopyMermaidButton } from '../components/CopyMermaidButton';
import { RefreshControl } from '../components/RefreshControl';
import { DataState } from '../components/DataState';

type MapView = 'namespaces' | 'services';

/**
 * Global Service Map (issue #22). The unclustered fleet map is ~1200 service
 * nodes / ~4000 edges — an unusable hairball that crashes the tab, which is why
 * the old global map page was removed. The default "Namespaces" view renders one
 * node per namespace (team) sized by service count, with cross-namespace call
 * edges; clicking a namespace drills into that namespace's own (bounded) scoped
 * map on the Namespace Overview page. "Services" exposes the full unclustered
 * graph for small deployments or deliberate deep inspection.
 */
function ServiceMap() {
  const styles = useStyles2(getStyles);
  const appNavigate = useAppNavigate();
  const [searchParams] = useSearchParams();
  const setUrlParams = useUrlParams();
  const { from, fromMs, toMs, setTimeRange, refresh: refreshTimeRange } = useTimeRange();
  const envFilter = sanitizeParam(searchParams.get('environment') ?? '');

  const configuredEnvs = useConfiguredEnvironments();
  const envOptions = useMemo(() => configuredEnvs.map((e) => ({ label: e, value: e })), [configuredEnvs]);

  // Clustered (namespace) map is always fetched — it is the default view and
  // also supplies the total service count that drives the default choice.
  const {
    data: clusteredData,
    loading: clusteredLoading,
    error: clusteredError,
    refetch: refetchClustered,
  } = useFetch<ClusteredServiceMapResponse>(
    () => getClusteredServiceMap(fromMs, toMs, envFilter || undefined),
    [fromMs, toMs, envFilter]
  );

  const totalServices = totalClusteredServices(clusteredData ?? null);

  // Default to namespaces at scale (>50 services); services view for small
  // deployments. An explicit ?view= param always wins. Before data loads we
  // assume the scaled (namespaces) default so we never flash the hairball.
  const urlView = searchParams.get('view');
  const view: MapView =
    urlView === 'services' || urlView === 'namespaces' ? urlView : totalServices > 50 ? 'namespaces' : 'services';

  // Full unclustered map is fetched lazily, only when the Services view is active.
  const {
    data: fullData,
    loading: fullLoading,
    refetch: refetchFull,
  } = useFetch<ServiceMapResponse>(
    () => getServiceMap(fromMs, toMs, undefined, undefined, envFilter || undefined),
    [fromMs, toMs, envFilter],
    { skip: view !== 'services' }
  );

  const isRelativeRange = from.startsWith('now');
  const handleRefresh = useCallback(() => {
    if (isRelativeRange) {
      refreshTimeRange();
      return;
    }
    refetchClustered();
    refetchFull();
  }, [isRelativeRange, refreshTimeRange, refetchClustered, refetchFull]);

  const setView = useCallback(
    (next: MapView) => {
      setUrlParams({ view: next }, { replace: true });
    },
    [setUrlParams]
  );

  const setEnvFilter = useCallback(
    (env: string) => {
      setUrlParams({ environment: env || null }, { replace: true });
    },
    [setUrlParams]
  );

  const activeData: ServiceMapResponse | null = view === 'namespaces' ? clusteredData : fullData;
  const { graphNodes, graphEdges } = useMemo(() => toGraphData(activeData), [activeData]);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      if (view === 'namespaces') {
        // Drill into the namespace's own scoped topology (bounded subset).
        appNavigate(`namespaces/${encodeURIComponent(nodeId)}`, envFilter ? { environment: envFilter } : undefined);
      } else {
        // Full-graph nodes are bare service names (no namespace); jump to the
        // service inventory pre-filtered so the user can pick the right one.
        appNavigate('services', { q: nodeId });
      }
    },
    [view, appNavigate, envFilter]
  );

  const viewOptions = [
    { label: 'Namespaces', value: 'namespaces' as MapView },
    { label: 'Services', value: 'services' as MapView },
  ];

  const loading = view === 'namespaces' ? clusteredLoading : clusteredLoading || fullLoading;
  const panelHeight = Math.min(900, Math.max(500, graphNodes.length * 22));

  return (
    <PluginPage layout={PageLayoutType.Canvas}>
      <div className={styles.container}>
        <div className={styles.headerRow}>
          <p className={styles.description}>
            Global service topology grouped by team. Each node is one namespace and edges show traffic between teams —
            click a team to drill into its own map.
          </p>
          <div className={styles.headerControls}>
            {envOptions.length > 0 && (
              <Combobox
                options={[{ label: 'All environments', value: '' }, ...envOptions]}
                value={envFilter}
                onChange={(v) => setEnvFilter(v?.value ?? '')}
                width={22}
                placeholder="Environment"
              />
            )}
            <Combobox
              options={QUICK_TIME_RANGES}
              value={from}
              onChange={(v) => setTimeRange(v?.value ?? 'now-1h', 'now')}
              width={22}
            />
            <RefreshControl onRefresh={handleRefresh} />
          </div>
        </div>

        <div className={styles.toolbar}>
          <RadioButtonGroup
            aria-label="Service map view"
            options={viewOptions}
            value={view}
            onChange={(v) => v && setView(v)}
            size="sm"
          />
          {view === 'namespaces' && clusteredData && (
            <span className={styles.counts}>
              {clusteredData.nodes.length} namespaces · {totalServices} services · {clusteredData.edges.length}{' '}
              cross-namespace edges
            </span>
          )}
          {view === 'services' && totalServices > 50 && (
            <span className={styles.warn}>
              <Tooltip content="The full graph renders every service and can be slow or unresponsive at fleet scale. Prefer the Namespaces view.">
                <span>
                  <Icon name="exclamation-triangle" /> {totalServices} services — full graph may be slow
                </span>
              </Tooltip>
            </span>
          )}
          {graphNodes.length > 0 && (
            <div className={styles.spacer}>
              <CopyMermaidButton nodes={graphNodes} edges={graphEdges} direction="DOWN" />
            </div>
          )}
        </div>

        <DataState
          loading={loading}
          error={clusteredError}
          errorTitle="Error loading service map"
          empty={!loading && graphNodes.length === 0}
          emptyTitle="No topology data"
          emptyMessage="No service-to-service traffic found for the selected time range and environment."
          loadingText="Loading service map..."
        >
          <div className={styles.graphPanel} style={{ height: panelHeight }}>
            <ServiceGraph
              nodes={graphNodes}
              edges={graphEdges}
              direction="DOWN"
              enableGrouping={false}
              enableWrapping={graphNodes.length > 15}
              onNodeClick={handleNodeClick}
            />
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
  description: css`
    color: ${theme.colors.text.secondary};
    margin: 0;
    max-width: 720px;
  `,
  headerRow: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: ${theme.spacing(2)};
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
  `,
  headerControls: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  toolbar: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    margin-bottom: ${theme.spacing(1.5)};
    flex-wrap: wrap;
  `,
  counts: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  warn: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.warning.text};
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    cursor: help;
  `,
  spacer: css`
    margin-left: auto;
  `,
  graphPanel: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)};
    overflow: hidden;
    display: flex;
  `,
});

export default ServiceMap;
