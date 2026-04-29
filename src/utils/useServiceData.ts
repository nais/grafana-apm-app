import { useMemo } from 'react';
import {
  getOperations,
  getServices,
  getServiceMap,
  getConnectedServices,
  getServiceDependencies,
  OperationSummary,
  ServiceSummary,
  ServiceMapResponse,
  ConnectedServicesResponse,
  DependenciesResponse,
} from '../api/client';
import { useFetch } from './useFetch';
import { toGraphData } from '../components/ServiceGraph';
import { extractEnvironmentOptions } from './options';

export interface ServiceDataParams {
  service: string;
  namespace: string;
  envFilter: string;
  fromMs: number;
  toMs: number;
  depth?: number;
}

export interface ServiceData {
  /** All services for SDK badge + env list */
  serviceList: ServiceSummary[] | null;
  /** Framework identifier for the current service */
  framework: string;
  /** Available environments across all services */
  envOptions: Array<{ label: string; value: string }>;
  /** Whether this service has SERVER-kind spans */
  hasServerSpans: boolean;
  /** Operations for the service */
  operations: OperationSummary[];
  opsLoading: boolean;
  opsError: string | null;
  /** Service map graph data */
  graphNodes: ReturnType<typeof toGraphData>['graphNodes'];
  graphEdges: ReturnType<typeof toGraphData>['graphEdges'];
  /** Connected (inbound) services */
  connected: ConnectedServicesResponse | null;
  connectedLoading: boolean;
  /** Dependencies (outbound) */
  depsResp: DependenciesResponse | null;
  depsLoading: boolean;
  depsError: string | null;
}

/**
 * Encapsulates all data fetching for the ServiceOverview page.
 * Returns a stable object with all the data and loading states
 * needed by the tabs and layout.
 */
export function useServiceData({ service, namespace, envFilter, fromMs, toMs, depth }: ServiceDataParams): ServiceData {
  // Fetch service list (for SDK badge + environment list)
  const { data: serviceList } = useFetch(() => getServices(fromMs, toMs, 60, false), [fromMs, toMs]);

  const framework = useMemo(() => {
    const match = serviceList?.find((s) => s.name === service && s.namespace === namespace);
    return match?.framework ?? '';
  }, [serviceList, service, namespace]);

  const envOptions = useMemo(() => extractEnvironmentOptions(serviceList ?? []), [serviceList]);

  // Fetch operations
  const {
    data: rawOperations,
    loading: opsLoading,
    error: opsError,
  } = useFetch<OperationSummary[]>(
    () => getOperations(namespace, service, fromMs, toMs),
    [service, namespace, fromMs, toMs]
  );
  const operations = useMemo(() => rawOperations ?? [], [rawOperations]);

  // Fetch service map for overview graph
  const { data: mapData } = useFetch<ServiceMapResponse>(
    () => getServiceMap(fromMs, toMs, service, namespace, envFilter, depth),
    [service, namespace, envFilter, fromMs, toMs, depth]
  );
  const { graphNodes, graphEdges } = useMemo(() => toGraphData(mapData), [mapData]);

  // Fetch callers (inbound connected services)
  const { data: connected, loading: connectedLoading } = useFetch<ConnectedServicesResponse>(
    () => getConnectedServices(namespace, service, fromMs, toMs, envFilter || undefined),
    [service, namespace, fromMs, toMs, envFilter]
  );

  // Fetch dependencies (outbound)
  const {
    data: depsResp,
    loading: depsLoading,
    error: depsError,
  } = useFetch<DependenciesResponse>(
    () => getServiceDependencies(namespace, service, fromMs, toMs, envFilter || undefined),
    [service, namespace, fromMs, toMs, envFilter]
  );

  // Determine if this service has SERVER spans (for query filter strategy).
  const hasServerSpans = useMemo(() => {
    if (!serviceList) {
      return true; // safe default while loading
    }
    const matches = serviceList.filter(
      (s) => s.name === service && s.namespace === namespace && (!envFilter || s.environment === envFilter)
    );
    return matches.length === 0 || matches.some((s) => s.hasServerSpans);
  }, [serviceList, service, namespace, envFilter]);

  return {
    serviceList,
    framework,
    envOptions,
    hasServerSpans,
    operations,
    opsLoading,
    opsError,
    graphNodes,
    graphEdges,
    connected,
    connectedLoading,
    depsResp,
    depsLoading,
    depsError,
  };
}
