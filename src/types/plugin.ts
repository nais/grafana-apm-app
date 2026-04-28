/** Shared type definitions for plugin configuration (jsonData schema). */

/** Reference to a Grafana datasource by UID. */
export interface DsRef {
  uid?: string;
  type?: string;
}

/** Datasource reference with optional per-environment overrides. */
export interface EnvAwareDs {
  uid?: string;
  type?: string;
  byEnvironment?: Record<string, DsRef>;
}

/** The plugin's jsonData schema — persisted in Grafana's plugin settings. */
export interface AppPluginSettings {
  metricsDataSource?: DsRef;
  tracesDataSource?: EnvAwareDs;
  logsDataSource?: EnvAwareDs;
  metricNamespace?: string;
  durationUnit?: string;
}
