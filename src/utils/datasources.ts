import { useEffect, useMemo, useState } from 'react';
import pluginJson from '../plugin.json';

interface PluginDatasources {
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
// Grafana's frontend config does NOT include jsonData for app plugins,
// so we always fetch it from the REST API.
let _jsonDataCache: Record<string, any> | null = null;
let _jsonDataPromise: Promise<Record<string, any>> | null = null;
let _listeners: Array<() => void> = [];

function notifyListeners() {
  _listeners.forEach((fn) => fn());
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
  if (_jsonDataCache) {
    return;
  }
  if (!_jsonDataPromise) {
    _jsonDataPromise = fetchJsonData().then((jd) => {
      _jsonDataCache = jd;
      notifyListeners();
      return jd;
    });
  }
}

function getJsonData(): Record<string, any> {
  return _jsonDataCache ?? {};
}

/** Read datasource UIDs from plugin config, optionally resolved for an environment */
function getPluginDatasources(env?: string): PluginDatasources {
  const jsonData = getJsonData();
  const tracesDs: EnvAwareDs = jsonData.tracesDataSource ?? {};
  const logsDs: EnvAwareDs = jsonData.logsDataSource ?? {};

  const tracesUid = resolveUid(tracesDs, env, 'tempo');
  const logsUid = resolveUid(logsDs, env, 'loki');
  const isEnvSpecific = !!env && (!!tracesDs.byEnvironment?.[env]?.uid || !!logsDs.byEnvironment?.[env]?.uid);

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
