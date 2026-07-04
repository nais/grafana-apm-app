import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import pluginJson from '../plugin.json';

// Cron/Naisjob monitoring (roadmap M7), built from kube-state-metrics. The
// fetch/param helpers mirror client.ts (module-private there); kept local to
// avoid widening client.ts's exported surface, matching analytics.ts.

const BASE_URL = `/api/plugins/${pluginJson.id}/resources`;

async function fetchResource<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = params ? `${BASE_URL}${path}?${new URLSearchParams(params).toString()}` : `${BASE_URL}${path}`;
  const response = await lastValueFrom(getBackendSrv().fetch<T>({ url, method: 'GET' }));
  return response.data;
}

/** Convert millisecond timestamps to the seconds-based params the backend expects. */
function timeParams(from: number, to: number): Record<string, string> {
  return { from: String(Math.floor(from / 1000)), to: String(Math.floor(to / 1000)) };
}

export type JobOutcome = 'succeeded' | 'failed' | 'running' | 'unknown';
export type JobStatus = 'ok' | 'failing' | 'unknown';

export interface JobRun {
  outcome: JobOutcome;
  startMs?: number;
  completionMs?: number;
  /** completion - start, in seconds; present only when the run completed. */
  durationSec?: number;
  reason?: string;
}

export interface JobEntry {
  name: string;
  namespace: string;
  cluster: string;
  /** 'CronJob' (scheduled Naisjob) or 'Job' (one-shot). */
  kind: 'CronJob' | 'Job';
  schedule?: string;
  timezone?: string;
  lastRun?: JobRun;
  lastScheduleMs?: number;
  nextScheduleMs?: number;
  failureStreak: number;
  status: JobStatus;
  runCount: number;
}

export interface JobsResponse {
  available: boolean;
  jobs: JobEntry[];
  note?: string;
}

export async function getJobs(from: number, to: number, namespace?: string): Promise<JobsResponse> {
  const params: Record<string, string> = { ...timeParams(from, to) };
  if (namespace) {
    params.namespace = namespace;
  }
  return fetchResource<JobsResponse>('/jobs', params);
}
