import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import pluginJson from '../plugin.json';

// Service scorecard (M7): observability readiness + nais Console enrichment.
// The fetch/param helpers mirror client.ts (they are module-private there);
// kept local to avoid widening client.ts's exported surface (precedent:
// analytics.ts).

const BASE_URL = `/api/plugins/${pluginJson.id}/resources`;

/** Encode namespace for URL path segments, using '_' as placeholder for empty. */
function nsParam(namespace: string): string {
  return encodeURIComponent(namespace || '_');
}

async function fetchResource<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = params ? `${BASE_URL}${path}?${new URLSearchParams(params).toString()}` : `${BASE_URL}${path}`;
  const response = await lastValueFrom(getBackendSrv().fetch<T>({ url, method: 'GET' }));
  return response.data;
}

export interface ScorecardCheck {
  key: string;
  label: string;
  ok: boolean;
  /** How to enable the capability (one sentence, nais-flavored). */
  hint: string;
}

export interface ScorecardReadiness {
  /** Number of passing checks; the fraction is score/total. */
  score: number;
  total: number;
  checks: ScorecardCheck[];
}

export interface ScorecardConsole {
  /** False when no nais Console API is configured — the UI shows nothing then. */
  configured: boolean;
  teamSlug?: string;
  slackChannel?: string;
  repositoryUrl?: string;
  ingresses?: string[];
}

export interface ScorecardResponse {
  readiness: ScorecardReadiness;
  console: ScorecardConsole;
}

export async function getScorecard(
  namespace: string,
  service: string,
  environment?: string
): Promise<ScorecardResponse> {
  return fetchResource<ScorecardResponse>(
    `/services/${nsParam(namespace)}/${encodeURIComponent(service)}/scorecard`,
    environment ? { environment } : undefined
  );
}
