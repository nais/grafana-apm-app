import { useMemo } from 'react';
import { config } from '@grafana/runtime';
import pluginJson from '../plugin.json';

export interface PluginDatasources {
  metricsUid: string;
  tracesUid: string;
  logsUid: string;
}

/** Read datasource UIDs from plugin config, falling back to defaults */
export function getPluginDatasources(): PluginDatasources {
  const meta = config.apps?.[pluginJson.id];
  const jsonData = (meta as any)?.jsonData ?? {};
  return {
    metricsUid: jsonData.metricsDataSource?.uid || 'mimir',
    tracesUid: jsonData.tracesDataSource?.uid || 'tempo',
    logsUid: jsonData.logsDataSource?.uid || 'loki',
  };
}

/** Hook that returns memoized datasource config */
export function usePluginDatasources(): PluginDatasources {
  return useMemo(() => getPluginDatasources(), []);
}
