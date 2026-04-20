import { useEffect, useMemo, useState } from 'react';
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

// Cached jsonData fetched from the plugin settings API.
// Grafana's frontend config (config.apps) does NOT include jsonData for
// provisioned app plugins, so we fetch it once from the REST API.
let _jsonDataCache: Record<string, any> | null = null;
let _jsonDataPromise: Promise<Record<string, any>> | null = null;
let _listeners: Array<() => void> = [];

function notifyListeners() {
  _listeners.forEach((fn) => fn());
}

function getJsonDataFromConfig(): Record<string, any> {
  const meta = config.apps?.[pluginJson.id];
  return (meta as any)?.jsonData ?? {};
}

async function fetchJsonData(): Promise<Record<string, any>> {
  try {
    const resp = await fetch(`/api/plugins/${pluginJson.id}/settings`);
    if (resp.ok) {
      const data = await resp.json();
      return data?.jsonData ?? {};
    }
  } catch {
    // fall through
  }
  return {};
}

/** Initialize the jsonData cache. Call early (e.g. in module.tsx). */
export function initDatasourceConfig(): void {
  const fromConfig = getJsonDataFromConfig();
  if (fromConfig.metricsDataSource?.uid) {
    _jsonDataCache = fromConfig;
    return;
  }
  // jsonData missing from frontend config — fetch from API
  if (!_jsonDataPromise) {
    _jsonDataPromise = fetchJsonData().then((jd) => {
      _jsonDataCache = jd;
      notifyListeners();
      return jd;
    });
  }
}

function getJsonData(): Record<string, any> {
  if (_jsonDataCache) {
    return _jsonDataCache;
  }
  const fromConfig = getJsonDataFromConfig();
  if (fromConfig.metricsDataSource?.uid) {
    _jsonDataCache = fromConfig;
    return fromConfig;
  }
  return fromConfig;
}

/** Read datasource UIDs from plugin config, optionally resolved for an environment */
export function getPluginDatasources(env?: string): PluginDatasources {
  const jsonData = getJsonData();
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

/** Hook that returns memoized datasource config, optionally for a specific environment.
 *  Re-renders when the async config fetch completes. */
export function usePluginDatasources(env?: string): PluginDatasources {
  const [rev, setRev] = useState(0);
  useEffect(() => {
    const listener = () => setRev((r) => r + 1);
    _listeners.push(listener);
    return () => {
      _listeners = _listeners.filter((l) => l !== listener);
    };
  }, []);
  // rev triggers re-computation when async config updates arrive
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => getPluginDatasources(env), [env, rev]);
}

/** Returns the list of environments that have datasource overrides configured */
export function getConfiguredEnvironments(): string[] {
  const jsonData = getJsonData();
  const tracesEnvs = Object.keys(jsonData.tracesDataSource?.byEnvironment ?? {});
  const logsEnvs = Object.keys(jsonData.logsDataSource?.byEnvironment ?? {});
  return [...new Set([...tracesEnvs, ...logsEnvs])].sort();
}
