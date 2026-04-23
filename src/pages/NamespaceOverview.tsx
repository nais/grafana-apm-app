import React, { useCallback, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { Combobox, IconButton, useStyles2 } from '@grafana/ui';
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
import { extractEnvironmentOptions } from '../utils/options';
import { getSectionStyles } from '../utils/styles';
import { useFetch } from '../utils/useFetch';
import { toMermaidGraph } from '../utils/mermaid';
import { ServiceGraph, toGraphData } from '../components/ServiceGraph';
import { PageHeader } from '../components/PageHeader';
import { DataState } from '../components/DataState';
import { NamespaceStats } from './namespace/NamespaceStats';
import { NeedsAttention } from './namespace/NeedsAttention';
import { NamespaceServicesTable } from './namespace/NamespaceServicesTable';
import { NamespaceDependencies } from './namespace/NamespaceDependencies';

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
  const { from, fromMs, toMs } = useTimeRange();
  const healthFilter = searchParams.get('healthFilter') ?? '';

  // Fetch services for this namespace (fast, no sparklines)
  const {
    data: fetchResult,
    loading: servicesLoading,
    error: servicesError,
  } = useFetch<ServiceSummary[]>(
    () => getServices(fromMs, toMs, 60, false, { namespace: decodedNs, environment: envFilter || undefined }),
    [fromMs, toMs, decodedNs, envFilter]
  );

  // Fetch previous period for change deltas (only for relative time ranges, summary only)
  const isRelativeRange = from.startsWith('now');
  const rangeDuration = toMs - fromMs;
  const prevFromMs = fromMs - rangeDuration;
  const prevToMs = fromMs;
  const { data: prevServices } = useFetch<ServiceSummary[]>(
    () => getServices(prevFromMs, prevToMs, 60, false, { namespace: decodedNs, environment: envFilter || undefined }),
    [prevFromMs, prevToMs, decodedNs, envFilter],
    { skip: !isRelativeRange }
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

  const services = useMemo(() => (fetchResult ?? []).filter((s) => !s.isSidecar), [fetchResult]);

  const sparklineMap = useMemo(() => {
    if (!sparklineResult) {
      return new Map<string, ServiceSummary>();
    }
    return new Map(sparklineResult.map((s) => [`${s.namespace}/${s.name}/${s.environment ?? ''}`, s]));
  }, [sparklineResult]);

  // Compute unique environments for dropdown (from unfiltered data to prevent dropdown disappearing)
  const envOptions = useMemo(() => extractEnvironmentOptions(allEnvServices ?? []), [allEnvServices]);

  // Build lookup map of previous period services for delta comparison
  const previousMap = useMemo(() => {
    if (!prevServices) {
      return undefined;
    }
    const m = new Map<string, ServiceSummary>();
    for (const s of prevServices) {
      m.set(`${s.namespace}/${s.name}/${s.environment ?? ''}`, s);
    }
    return m;
  }, [prevServices]);

  // Use backend-filtered service map directly for topology
  const { graphNodes, graphEdges } = useMemo(() => {
    if (!mapData) {
      return { graphNodes: [], graphEdges: [] };
    }
    return toGraphData(mapData);
  }, [mapData]);

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

  const [mermaidCopied, setMermaidCopied] = useState(false);
  const handleCopyMermaid = useCallback(() => {
    const mermaid = toMermaidGraph(graphNodes, graphEdges, 'DOWN');
    navigator.clipboard.writeText(mermaid).then(() => {
      setMermaidCopied(true);
      setTimeout(() => setMermaidCopied(false), 2000);
    });
  }, [graphNodes, graphEdges]);

  return (
    <PluginPage layout={PageLayoutType.Canvas}>
      <div className={styles.container}>
        <PageHeader
          title={decodedNs}
          backLabel="Services"
          onBack={handleBack}
          controls={
            envOptions.length > 1 || envFilter ? (
              <Combobox
                options={[{ label: 'All environments', value: '' }, ...envOptions]}
                value={envFilter}
                onChange={(v) => setEnvFilter(v.value ?? '')}
                placeholder="All environments"
                width={28}
              />
            ) : undefined
          }
        />

        <DataState
          loading={servicesLoading}
          error={servicesError}
          errorTitle="Error loading services"
          empty={!servicesLoading && services.length === 0}
          emptyTitle="No services found"
          emptyMessage={
            <>
              No services found for namespace <strong>{decodedNs}</strong>
              {envFilter ? ` in environment ${envFilter}` : ''}.
            </>
          }
          loadingText="Loading namespace data..."
        >
          {/* Stats tiles */}
          <NamespaceStats services={services} previousMap={previousMap} sparklineMap={sparklineMap} />

          {/* Needs attention — unhealthy services */}
          <NeedsAttention
            services={services}
            sparklineMap={sparklineMap}
            previousMap={previousMap}
            onServiceClick={handleServiceClick}
          />

          {/* Topology graph */}
          {graphNodes.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h3 className={styles.sectionTitle}>Service Topology</h3>
                <IconButton
                  name={mermaidCopied ? 'check' : 'copy'}
                  tooltip={mermaidCopied ? 'Copied!' : 'Copy as Mermaid'}
                  size="md"
                  onClick={handleCopyMermaid}
                />
              </div>
              <div
                style={{
                  height: Math.min(700, Math.max(400, graphNodes.length * 35)),
                  borderRadius: 4,
                  overflow: 'hidden',
                }}
              >
                <ServiceGraph
                  nodes={graphNodes}
                  edges={graphEdges}
                  direction="DOWN"
                  enableGrouping={false}
                  enableWrapping={graphNodes.length > 15}
                  onNodeClick={(nodeId) => {
                    const svc = services.find((s) => s.name === nodeId);
                    if (svc) {
                      handleServiceClick(svc.namespace, svc.name);
                    }
                  }}
                />
              </div>
            </div>
          )}

          {/* Services table */}
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Services</h3>
            <NamespaceServicesTable
              services={services}
              sparklineMap={sparklineMap}
              previousMap={previousMap}
              showEnvironment={!envFilter && envOptions.length > 1}
              search={svcSearch}
              healthFilter={healthFilter}
              page={svcPage}
              onSearchChange={(q) => {
                setSearchParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    if (q) {
                      next.set('svcSearch', q);
                    } else {
                      next.delete('svcSearch');
                    }
                    next.delete('svcPage');
                    return next;
                  },
                  { replace: true }
                );
              }}
              onHealthFilterChange={(f) => updateParam('healthFilter', f || null)}
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
        </DataState>
      </div>
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  ...getSectionStyles(theme),
  container: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 0;
  `,
  sectionHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
});

export default NamespaceOverview;
