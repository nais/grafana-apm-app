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
  withSeries = true
): Promise<ServiceSummary[]> {
  return fetchResource<ServiceSummary[]>('/services', {
    from: String(Math.floor(from / 1000)),
    to: String(Math.floor(to / 1000)),
    step: String(step),
    withSeries: String(withSeries),
  });
}
