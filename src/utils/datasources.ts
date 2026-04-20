import { useMemo } from 'react';
import { config } from '@grafana/runtime';
import pluginJson from '../plugin.json';

export interface PluginDatasources {
  metricsUid: string;
  tracesUid: string;
  logsUid: string;
  /** Whether the current traces/logs UIDs came from an environment override */
  isEnvSpecific: boolean;
}

interface EnvAwareDs {
  uid?: string;
  type?: string;
  byEnvironment?: Record<string, { uid?: string; type?: string }>;
}

function resolveUid(ds: EnvAwareDs | undefined, env: string | undefined, fallback: string): string {
  if (env && ds?.byEnvironment?.[env]?.uid) {
    return ds.byEnvironment[env].uid!;
  }
  return ds?.uid || fallback;
}

/** Read datasource UIDs from plugin config, optionally resolved for an environment */
export function getPluginDatasources(env?: string): PluginDatasources {
  const meta = config.apps?.[pluginJson.id];
  const jsonData = (meta as any)?.jsonData ?? {};
  const tracesDs: EnvAwareDs = jsonData.tracesDataSource ?? {};
  const logsDs: EnvAwareDs = jsonData.logsDataSource ?? {};

  const tracesUid = resolveUid(tracesDs, env, 'tempo');
  const logsUid = resolveUid(logsDs, env, 'loki');
  const isEnvSpecific = !!env && (
    (!!tracesDs.byEnvironment?.[env]?.uid) || (!!logsDs.byEnvironment?.[env]?.uid)
  );

  return {
    metricsUid: jsonData.metricsDataSource?.uid || 'mimir',
    tracesUid,
    logsUid,
    isEnvSpecific,
  };
}

/** Hook that returns memoized datasource config, optionally for a specific environment */
export function usePluginDatasources(env?: string): PluginDatasources {
  return useMemo(() => getPluginDatasources(env), [env]);
}

/** Returns the list of environments that have datasource overrides configured */
export function getConfiguredEnvironments(): string[] {
  const meta = config.apps?.[pluginJson.id];
  const jsonData = (meta as any)?.jsonData ?? {};
  const tracesEnvs = Object.keys(jsonData.tracesDataSource?.byEnvironment ?? {});
  const logsEnvs = Object.keys(jsonData.logsDataSource?.byEnvironment ?? {});
  return [...new Set([...tracesEnvs, ...logsEnvs])].sort();
}
