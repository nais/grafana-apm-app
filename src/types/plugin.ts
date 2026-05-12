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

/** Label name overrides for non-standard OTel pipelines (e.g. Tempo metrics generator). */
export interface LabelOverrides {
  /** Default: "service_name". Tempo metrics generator emits "service". */
  serviceNameLabel?: string;
  /** Default: "service_namespace". Use "k8s_namespace_name" for Tempo with k8s.namespace.name dimension. */
  serviceNamespaceLabel?: string;
  /** Default: "k8s_cluster_name". */
  deploymentEnvLabel?: string;
}

/** The plugin's jsonData schema — persisted in Grafana's plugin settings. */
export interface AppPluginSettings {
  metricsDataSource?: DsRef;
  tracesDataSource?: EnvAwareDs;
  logsDataSource?: EnvAwareDs;
  metricNamespace?: string;
  durationUnit?: string;
  labelOverrides?: LabelOverrides;
  /** Ingress hostname → service name mapping for discovering on-prem callers via nais ingress. */
  ingressAliases?: Record<string, string>;
}
