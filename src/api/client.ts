import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import pluginJson from '../plugin.json';

const BASE_URL = `/api/plugins/${pluginJson.id}/resources`;

export interface SpanMetricsCapability {
  detected: boolean;
  namespace?: string;
  callsMetric?: string;
  durationMetric?: string;
  durationUnit?: string;
}

export interface ServiceGraphCapability {
  detected: boolean;
  prefix?: string;
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
  tempoByEnv?: Record<string, DataSourceStatus>;
  lokiByEnv?: Record<string, DataSourceStatus>;
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
  framework?: string;
  hasFrontend?: boolean;
  isSidecar?: boolean;
  rate: number;
  errorRate: number;
  p95Duration: number;
  durationUnit: string;
  rateSeries?: DataPoint[];
  errorSeries?: DataPoint[];
  durationSeries?: DataPoint[];
}

async function fetchResource<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = params ? `${BASE_URL}${path}?${new URLSearchParams(params).toString()}` : `${BASE_URL}${path}`;

  const response = await lastValueFrom(getBackendSrv().fetch<T>({ url, method: 'GET' }));
  return response.data;
}

/** Convert millisecond timestamps to the seconds-based params the backend expects. */
function timeParams(from: number, to: number): Record<string, string> {
  return { from: String(Math.floor(from / 1000)), to: String(Math.floor(to / 1000)) };
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
    ...timeParams(from, to),
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
    timeParams(from, to)
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
  nodeType?: 'service' | 'database' | 'messaging' | 'external';
  isSidecar?: boolean;
  errorRate: number;
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
    ...timeParams(from, to),
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
  connectionType?: string;
  isSidecar?: boolean;
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
    timeParams(from, to)
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

export interface DependencyOperation {
  spanName: string;
  callingService: string;
  dbName?: string;
  dbOperation?: string;
  messagingDestination?: string;
  rate: number;
  errorRate: number;
  p95Duration: number;
  durationUnit: string;
}

export interface DependencyDetailResponse {
  dependency: DependencySummary;
  upstreams: DependencySummary[];
  operations: DependencyOperation[];
}

export async function getServiceDependencies(
  namespace: string,
  service: string,
  from: number,
  to: number,
  environment?: string
): Promise<DependenciesResponse> {
  const params: Record<string, string> = {
    ...timeParams(from, to),
  };
  if (environment) {
    params.environment = environment;
  }
  return fetchResource<DependenciesResponse>(
    `/services/${encodeURIComponent(namespace)}/${encodeURIComponent(service)}/dependencies`,
    params
  );
}

export async function getGlobalDependencies(
  from: number,
  to: number,
  environment?: string
): Promise<DependenciesResponse> {
  const params: Record<string, string> = {
    ...timeParams(from, to),
  };
  if (environment) {
    params.environment = environment;
  }
  return fetchResource<DependenciesResponse>('/dependencies', params);
}

export async function getDependencyDetail(
  name: string,
  from: number,
  to: number,
  environment?: string
): Promise<DependencyDetailResponse> {
  const params: Record<string, string> = {
    ...timeParams(from, to),
  };
  if (environment) {
    params.environment = environment;
  }
  return fetchResource<DependencyDetailResponse>(`/dependencies/${encodeURIComponent(name)}`, params);
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
  messagingKind?: string;
}

export interface EndpointGroups {
  http: EndpointSummary[];
  grpc: EndpointSummary[];
  database: EndpointSummary[];
  messaging: EndpointSummary[];
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
    timeParams(from, to)
  );
}

// ---- Frontend / Faro metrics ----

export interface FrontendMetricsResponse {
  available: boolean;
  source?: string; // "mimir" or "loki"
  vitals?: Record<string, number>;
  errorRate: number;
}

export async function getFrontendMetrics(
  namespace: string,
  service: string,
  environment?: string
): Promise<FrontendMetricsResponse> {
  const params: Record<string, string> = {};
  if (environment) {
    params.environment = environment;
  }
  return fetchResource<FrontendMetricsResponse>(
    `/services/${encodeURIComponent(namespace)}/${encodeURIComponent(service)}/frontend`,
    Object.keys(params).length > 0 ? params : undefined
  );
}

export interface GraphQLOperation {
  name: string;
  type?: string;
  rate: number;
  errorRate: number | null;
  avgLatency: number;
  latencyUnit: string;
}

export interface GraphQLMetricsResponse {
  detected: boolean;
  framework?: string;
  operations?: GraphQLOperation[];
  fetchers?: GraphQLOperation[];
}

export async function getGraphQLMetrics(
  namespace: string,
  service: string,
  from: number,
  to: number
): Promise<GraphQLMetricsResponse> {
  return fetchResource<GraphQLMetricsResponse>(
    `/services/${encodeURIComponent(namespace)}/${encodeURIComponent(service)}/graphql`,
    timeParams(from, to)
  );
}

// ---- Runtime metrics (JVM, Node.js, DB Pool, Kafka) ----

export type DetectionStatus = 'detected' | 'absent' | 'error';

export interface RuntimeVersion {
  version: string;
  runtime?: string;
  count: number;
}

export interface JVMRuntime {
  status: DetectionStatus;
  heapUsed: number;
  heapMax: number;
  heapCommitted: number;
  nonHeapUsed: number;
  gcPauseRate: number;
  gcPauseAvg: number;
  gcOverhead: number;
  threadsLive: number;
  threadsDaemon: number;
  threadsPeak: number;
  threadStates?: Record<string, number>;
  classesLoaded: number;
  cpuUtilization: number;
  cpuCount: number;
  uptime: number;
  bufferUsed: number;
  bufferCapacity: number;
  memoryPools?: MemoryPool[];
  gcTypes?: GCType[];
  versions?: RuntimeVersion[];
  podCount: number;
}

export interface MemoryPool {
  name: string;
  area: string;
  used: number;
  max: number;
}

export interface GCType {
  name: string;
  rate: number;
  avgPause: number;
  p99Pause: number;
}

export interface NodeJSRuntime {
  status: DetectionStatus;
  eventLoopP99: number;
  eventLoopP90: number;
  eventLoopP50: number;
  eventLoopMean: number;
  eventLoopUtil: number;
  heapUsed: number;
  heapTotal: number;
  externalMem: number;
  rss: number;
  gcRate: number;
  activeHandles: number;
  activeRequests: number;
  cpuUsage: number;
  openFds: number;
  maxFds: number;
  versions?: RuntimeVersion[];
  podCount: number;
}

export interface DBPool {
  name: string;
  type: string;
  active: number;
  idle: number;
  max: number;
  pending: number;
  timeoutRate: number;
  utilization: number;
}

export interface DBPoolRuntime {
  status: DetectionStatus;
  pools: DBPool[];
}

export interface KafkaTopic {
  topic: string;
  maxLag: number;
  partitions: number;
  consumeRate: number;
  produceRate: number;
}

export interface KafkaRuntime {
  status: DetectionStatus;
  topics: KafkaTopic[];
}

export interface ContainerRuntime {
  status: DetectionStatus;
  cpuUsage: number;
  cpuRequests: number;
  cpuLimits: number;
  cpuThrottled: number;
  memoryUsage: number;
  memoryRequests: number;
  memoryLimits: number;
  restarts: number;
  podCount: number;
  desiredReplicas: number;
}

export interface GoRuntime {
  status: DetectionStatus;
  goroutines: number;
  threads: number;
  memAlloc: number;
  memSys: number;
  gcRate: number;
  gcPauseAvg: number;
  cpuUsage: number;
  openFds: number;
  maxFds: number;
  versions?: RuntimeVersion[];
  podCount: number;
}

export interface RuntimeResponse {
  container?: ContainerRuntime;
  jvm?: JVMRuntime;
  nodejs?: NodeJSRuntime;
  go?: GoRuntime;
  dbPool?: DBPoolRuntime;
  kafka?: KafkaRuntime;
}

export async function getRuntimeMetrics(
  namespace: string,
  service: string,
  from: number,
  to: number
): Promise<RuntimeResponse> {
  return fetchResource<RuntimeResponse>(
    `/services/${encodeURIComponent(namespace)}/${encodeURIComponent(service)}/runtime`,
    timeParams(from, to)
  );
}
