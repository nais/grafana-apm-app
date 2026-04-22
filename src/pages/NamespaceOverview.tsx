import React, { useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { Alert, Combobox, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2, PageLayoutType } from '@grafana/data';
import { css } from '@emotion/css';
import {
  getServices,
  getServiceMap,
  getNamespaceDependencies,
  ServiceSummary,
  ServiceMapResponse,
  NamespaceDependenciesResponse,
} from '../api/client';
import { useTimeRange } from '../utils/timeRange';
import { useAppNavigate, sanitizeParam } from '../utils/navigation';
import { useFetch } from '../utils/useFetch';
import { ServiceGraph, toGraphData } from '../components/ServiceGraph';
import { BackButton } from '../components/BackButton';
import { NamespaceStats } from './namespace/NamespaceStats';
import { NamespaceServicesTable } from './namespace/NamespaceServicesTable';
import { NamespaceDependencies } from './namespace/NamespaceDependencies';

const TOPOLOGY_SERVICE_CAP = 20;

function NamespaceOverview() {
  const { namespace = '' } = useParams<{ namespace: string }>();
  const decodedNs = decodeURIComponent(namespace);
  const appNavigate = useAppNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const styles = useStyles2(getStyles);
  const envFilter = sanitizeParam(searchParams.get('environment') ?? '');
  const svcSearch = searchParams.get('svcSearch') ?? '';
  const svcPage = Math.max(1, parseInt(searchParams.get('svcPage') ?? '1', 10) || 1);
  const depPage = Math.max(1, parseInt(searchParams.get('depPage') ?? '1', 10) || 1);
  const { fromMs, toMs } = useTimeRange();

  // Fetch services for this namespace (fast, no sparklines)
  const {
    data: fetchResult,
    loading: servicesLoading,
    error: servicesError,
  } = useFetch<ServiceSummary[]>(
    () => getServices(fromMs, toMs, 60, false, { namespace: decodedNs, environment: envFilter || undefined }),
    [fromMs, toMs, decodedNs, envFilter]
  );

  // Separate fetch without env filter to discover available environments
  const { data: allEnvServices } = useFetch<ServiceSummary[]>(
    () => getServices(fromMs, toMs, 60, false, { namespace: decodedNs }),
    [fromMs, toMs, decodedNs]
  );

  // Lazy-load sparklines after initial data is on screen
  const { data: sparklineResult } = useFetch<ServiceSummary[]>(
    () => getServices(fromMs, toMs, 60, true, { namespace: decodedNs, environment: envFilter || undefined }),
    [fromMs, toMs, decodedNs, envFilter],
    { skip: !fetchResult }
  );

  // Fetch service map filtered by namespace (backend filters via spanmetrics namespace mapping)
  const { data: mapData } = useFetch<ServiceMapResponse>(
    () => getServiceMap(fromMs, toMs, undefined, decodedNs, envFilter || undefined),
    [fromMs, toMs, decodedNs, envFilter]
  );

  // Fetch namespace dependencies from dedicated backend endpoint
  const { data: depsResult, loading: depsLoading } = useFetch<NamespaceDependenciesResponse>(
    () => getNamespaceDependencies(decodedNs, fromMs, toMs, envFilter || undefined),
    [fromMs, toMs, decodedNs, envFilter]
  );

  const services = useMemo(() => fetchResult ?? [], [fetchResult]);

  const sparklineMap = useMemo(() => {
    if (!sparklineResult) {
      return new Map<string, ServiceSummary>();
    }
    return new Map(sparklineResult.map((s) => [`${s.namespace}/${s.name}/${s.environment ?? ''}`, s]));
  }, [sparklineResult]);

  // Set of service names in this namespace (for topology cap check)
  const namespaceServiceNames = useMemo(() => new Set(services.map((s) => s.name)), [services]);

  // Compute unique environments for dropdown (from unfiltered data to prevent dropdown disappearing)
  const envOptions = useMemo<Array<{ label: string; value: string }>>(() => {
    const envs = new Set((allEnvServices ?? []).map((s) => s.environment).filter((e): e is string => !!e));
    return [...envs].sort().map((e) => ({ label: e, value: e }));
  }, [allEnvServices]);

  // Use backend-filtered service map directly for topology
  const { graphNodes, graphEdges } = useMemo(() => {
    if (!mapData) {
      return { graphNodes: [], graphEdges: [] };
    }
    return toGraphData(mapData);
  }, [mapData]);

  const showTopology =
    namespaceServiceNames.size > 0 && namespaceServiceNames.size <= TOPOLOGY_SERVICE_CAP && graphNodes.length > 0;

  const setEnvFilter = useCallback(
    (env: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (env) {
            next.set('environment', env);
          } else {
            next.delete('environment');
          }
          // Reset pages when env changes
          next.delete('svcPage');
          next.delete('depPage');
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value && value !== '1' && value !== '') {
            next.set(key, value);
          } else {
            next.delete(key);
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
    appNavigate('');
  }, [appNavigate]);

  return (
    <PluginPage layout={PageLayoutType.Standard}>
      <div className={styles.container}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <BackButton label="Services" onClick={handleBack} />
            <h2 className={styles.title}>{decodedNs}</h2>
          </div>
          <div className={styles.headerRight}>
            {(envOptions.length > 1 || envFilter) && (
              <Combobox
                options={[{ label: 'All environments', value: '' }, ...envOptions]}
                value={envFilter}
                onChange={(v) => setEnvFilter(v.value ?? '')}
                placeholder="All environments"
                width={28}
              />
            )}
          </div>
        </div>

        {/* Loading / error states */}
        {servicesError && (
          <Alert severity="error" title="Error loading services">
            {servicesError}
          </Alert>
        )}
        {servicesLoading && <LoadingPlaceholder text="Loading namespace data..." />}

        {!servicesLoading && services.length === 0 && (
          <Alert severity="info" title="No services found">
            No services found for namespace <strong>{decodedNs}</strong>
            {envFilter ? ` in environment ${envFilter}` : ''}.
          </Alert>
        )}

        {!servicesLoading && services.length > 0 && (
          <>
            {/* Stats tiles */}
            <NamespaceStats services={services} />

            {/* Topology graph */}
            {showTopology && (
              <div className={styles.section}>
                <h3 className={styles.sectionTitle}>Service Topology</h3>
                <ServiceGraph
                  nodes={graphNodes}
                  edges={graphEdges}
                  direction="RIGHT"
                  enableGrouping={false}
                  onNodeClick={(nodeId) => {
                    const svc = services.find((s) => s.name === nodeId);
                    if (svc) {
                      handleServiceClick(svc.namespace, svc.name);
                    }
                  }}
                />
              </div>
            )}
            {namespaceServiceNames.size > TOPOLOGY_SERVICE_CAP && (
              <Alert severity="info" title="Topology hidden">
                Service topology is hidden for namespaces with more than {TOPOLOGY_SERVICE_CAP} services.
              </Alert>
            )}

            {/* Services table */}
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Services</h3>
              <NamespaceServicesTable
                services={services}
                sparklineMap={sparklineMap}
                showEnvironment={!envFilter && envOptions.length > 1}
                search={svcSearch}
                page={svcPage}
                onSearchChange={(q) => updateParam('svcSearch', q || null)}
                onPageChange={(p) => updateParam('svcPage', p > 1 ? String(p) : null)}
                onServiceClick={handleServiceClick}
              />
            </div>

            {/* External dependencies */}
            {!depsLoading && depsResult && (
              <NamespaceDependencies
                dependencies={depsResult.dependencies}
                page={depPage}
                onPageChange={(p) => updateParam('depPage', p > 1 ? String(p) : null)}
              />
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
    padding: ${theme.spacing(2)};
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: ${theme.spacing(3)};
    flex-wrap: wrap;
    gap: ${theme.spacing(1)};
  `,
  headerLeft: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  headerRight: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  title: css`
    margin: 0;
    font-size: ${theme.typography.h2.fontSize};
  `,
  section: css`
    margin-top: ${theme.spacing(3)};
  `,
  sectionTitle: css`
    margin-bottom: ${theme.spacing(1)};
    font-size: ${theme.typography.h4.fontSize};
  `,
});

export default NamespaceOverview;
