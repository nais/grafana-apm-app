import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import pluginJson from '../plugin.json';
import type { ServiceMapResponse, ServiceMapNode } from './client';

/**
 * Global service map API additions (issue #22).
 *
 * Kept out of client.ts on purpose: the clustered endpoint is a distinct,
 * fleet-wide aggregation used only by the global Service Map page. Reuses the
 * shared ServiceMapResponse shape so the existing ServiceGraph/toGraphData
 * rendering path works unchanged.
 */

const BASE_URL = `/api/plugins/${pluginJson.id}/resources`;

/**
 * A node in the clustered (namespace-level) service map. Extends the base
 * ServiceMapNode with the distinct-service count the backend attributes to the
 * namespace, used to size the cluster and drive the count badge.
 */
export interface ClusteredServiceMapNode extends ServiceMapNode {
  serviceCount?: number;
}

export interface ClusteredServiceMapResponse extends ServiceMapResponse {
  nodes: ClusteredServiceMapNode[];
}

async function fetchResource<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = params ? `${BASE_URL}${path}?${new URLSearchParams(params).toString()}` : `${BASE_URL}${path}`;
  const response = await lastValueFrom(getBackendSrv().fetch<T>({ url, method: 'GET' }));
  return response.data;
}

function timeParams(from: number, to: number): Record<string, string> {
  return { from: String(Math.floor(from / 1000)), to: String(Math.floor(to / 1000)) };
}

/**
 * Fetch the namespace-clustered global service map: one node per namespace
 * (team), sized by distinct service count, with cross-namespace call-rate edges.
 * The unclustered fleet map is ~1200 nodes / ~4000 edges — clustering collapses
 * it to ~130 namespace nodes.
 */
export async function getClusteredServiceMap(
  from: number,
  to: number,
  environment?: string
): Promise<ClusteredServiceMapResponse> {
  const params: Record<string, string> = { ...timeParams(from, to) };
  if (environment) {
    params.environment = environment;
  }
  return fetchResource<ClusteredServiceMapResponse>('/service-map/clustered', params);
}

/** Total distinct services represented across all clustered namespace nodes. */
export function totalClusteredServices(resp: ClusteredServiceMapResponse | null): number {
  if (!resp) {
    return 0;
  }
  return resp.nodes.reduce((sum, n) => sum + (n.serviceCount ?? 0), 0);
}
