import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import pluginJson from '../plugin.json';

const BASE_URL = `/api/plugins/${pluginJson.id}/resources`;

export interface DataSourceRef {
  uid: string;
  type: string;
}

export interface SpanMetricsCapability {
  detected: boolean;
  namespace?: string;
  callsMetric?: string;
  durationMetric?: string;
  durationUnit?: string;
}

export interface ServiceGraphCapability {
  detected: boolean;
}

export interface DataSourceStatus {
  available: boolean;
  error?: string;
}

export interface Capabilities {
  spanMetrics: SpanMetricsCapability;
  serviceGraph: ServiceGraphCapability;
  tempo: DataSourceStatus;
  loki: DataSourceStatus;
  services: string[];
}

export interface DataPoint {
  t: number;
  v: number;
}

export interface ServiceSummary {
  name: string;
  namespace: string;
  environment?: string;
  sdkLanguage?: string;
  rate: number;
  errorRate: number;
  p95Duration: number;
  durationUnit: string;
  rateSeries?: DataPoint[];
  durationSeries?: DataPoint[];
}

async function fetchResource<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = params
    ? `${BASE_URL}${path}?${new URLSearchParams(params).toString()}`
    : `${BASE_URL}${path}`;

  const response = await lastValueFrom(
    getBackendSrv().fetch<T>({ url, method: 'GET' })
  );
  return response.data;
}

export async function getCapabilities(): Promise<Capabilities> {
  return fetchResource<Capabilities>('/capabilities');
}

export async function getServices(
  from: number,
  to: number,
  step = 60,
  withSeries = true,
  filters?: { namespace?: string; environment?: string }
): Promise<ServiceSummary[]> {
  const params: Record<string, string> = {
    from: String(Math.floor(from / 1000)),
    to: String(Math.floor(to / 1000)),
    step: String(step),
    withSeries: String(withSeries),
  };
  if (filters?.namespace) {
    params.namespace = filters.namespace;
  }
  if (filters?.environment) {
    params.environment = filters.environment;
  }
  return fetchResource<ServiceSummary[]>('/services', params);
}

export interface OperationSummary {
  spanName: string;
  spanKind: string;
  rate: number;
  errorRate: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
  durationUnit: string;
}

export async function getOperations(
  namespace: string,
  service: string,
  from: number,
  to: number
): Promise<OperationSummary[]> {
  return fetchResource<OperationSummary[]>(
    `/services/${encodeURIComponent(namespace)}/${encodeURIComponent(service)}/operations`,
    {
      from: String(Math.floor(from / 1000)),
      to: String(Math.floor(to / 1000)),
    }
  );
}

export interface ServiceMapNode {
  id: string;
  title: string;
  subtitle?: string;
  mainStat?: string;
  secondaryStat?: string;
  arc__errors: number;
  arc__ok: number;
}

export interface ServiceMapEdge {
  id: string;
  source: string;
  target: string;
  mainStat?: string;
  secondaryStat?: string;
}

export interface ServiceMapResponse {
  nodes: ServiceMapNode[];
  edges: ServiceMapEdge[];
}

export async function getServiceMap(
  from: number,
  to: number,
  service?: string,
  namespace?: string
): Promise<ServiceMapResponse> {
  const params: Record<string, string> = {
    from: String(Math.floor(from / 1000)),
    to: String(Math.floor(to / 1000)),
  };
  if (service) {
    params.service = service;
  }
  if (namespace) {
    params.namespace = namespace;
  }
  return fetchResource<ServiceMapResponse>('/service-map', params);
}

// ---- Connected Services ----

export interface ConnectedService {
  name: string;
  rate: number;
  errorRate: number;
  p95Duration: number;
  durationUnit: string;
}

export interface ConnectedServicesResponse {
  inbound: ConnectedService[];
  outbound: ConnectedService[];
}

export async function getConnectedServices(
  namespace: string,
  service: string,
  from: number,
  to: number
): Promise<ConnectedServicesResponse> {
  return fetchResource<ConnectedServicesResponse>(
    `/services/${encodeURIComponent(namespace)}/${encodeURIComponent(service)}/connected`,
    {
      from: String(Math.floor(from / 1000)),
      to: String(Math.floor(to / 1000)),
    }
  );
}

// ---- Dependencies ----

export interface DependencySummary {
  name: string;
  type: string;
  rate: number;
  errorRate: number;
  p95Duration: number;
  durationUnit: string;
  impact: number;
}

export interface DependenciesResponse {
  dependencies: DependencySummary[];
}

export interface DependencyDetailResponse {
  dependency: DependencySummary;
  upstreams: DependencySummary[];
  operations: OperationSummary[];
}

export async function getServiceDependencies(
  namespace: string,
  service: string,
  from: number,
  to: number
): Promise<DependenciesResponse> {
  return fetchResource<DependenciesResponse>(
    `/services/${encodeURIComponent(namespace)}/${encodeURIComponent(service)}/dependencies`,
    {
      from: String(Math.floor(from / 1000)),
      to: String(Math.floor(to / 1000)),
    }
  );
}

export async function getGlobalDependencies(
  from: number,
  to: number
): Promise<DependenciesResponse> {
  return fetchResource<DependenciesResponse>('/dependencies', {
    from: String(Math.floor(from / 1000)),
    to: String(Math.floor(to / 1000)),
  });
}

export async function getDependencyDetail(
  name: string,
  from: number,
  to: number
): Promise<DependencyDetailResponse> {
  return fetchResource<DependencyDetailResponse>(
    `/dependencies/${encodeURIComponent(name)}`,
    {
      from: String(Math.floor(from / 1000)),
      to: String(Math.floor(to / 1000)),
    }
  );
}

// ---- Endpoints (Server tab) ----

export interface EndpointSummary {
  spanName: string;
  rate: number;
  errorRate: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
  durationUnit: string;
  httpMethod?: string;
  httpRoute?: string;
  rpcService?: string;
  rpcMethod?: string;
  dbSystem?: string;
}

export interface EndpointGroups {
  http: EndpointSummary[];
  grpc: EndpointSummary[];
  database: EndpointSummary[];
  internal: EndpointSummary[];
  durationUnit: string;
}

export async function getEndpoints(
  namespace: string,
  service: string,
  from: number,
  to: number
): Promise<EndpointGroups> {
  return fetchResource<EndpointGroups>(
    `/services/${encodeURIComponent(namespace)}/${encodeURIComponent(service)}/endpoints`,
    {
      from: String(Math.floor(from / 1000)),
      to: String(Math.floor(to / 1000)),
    }
  );
}

// ---- Frontend / Faro metrics ----

export interface FrontendMetricsResponse {
  available: boolean;
  vitals?: Record<string, number>;
  errorRate: number;
}

export async function getFrontendMetrics(
  namespace: string,
  service: string
): Promise<FrontendMetricsResponse> {
  return fetchResource<FrontendMetricsResponse>(
    `/services/${encodeURIComponent(namespace)}/${encodeURIComponent(service)}/frontend`
  );
}
