/**
 * Centralised OpenTelemetry naming conventions for the frontend.
 *
 * Every PromQL label name, span-kind value, status-code value, TraceQL
 * attribute path, and browser-metric name used in Scenes panels or Explore
 * links should come from this object — not from string literals.
 *
 * The object is intentionally plain (no class, no async) so it can be
 * imported cheaply from any module.  It mirrors the Go backend's
 * `pkg/plugin/otelconfig` package.
 */

export const otel = {
  labels: {
    serviceName: 'service_name',
    serviceNamespace: 'service_namespace',
    spanName: 'span_name',
    spanKind: 'span_kind',
    statusCode: 'status_code',
    httpMethod: 'http_method',
    httpRoute: 'http_route',
    httpStatusCode: 'http_response_status_code',
    rpcService: 'rpc_service',
    rpcMethod: 'rpc_method',
    dbSystem: 'db_system',
    dbName: 'db_name',
    dbOperation: 'db_operation',
    deploymentEnv: 'k8s_cluster_name',
    sdkLanguage: 'telemetry_sdk_language',
    le: 'le',
    // Service-graph specific
    client: 'client',
    server: 'server',
    connectionType: 'connection_type',
    // Spanmetrics dependency labels
    serverAddress: 'server_address',
    httpHost: 'http_host',
    messagingSystem: 'messaging_system',
    messagingDestination: 'messaging_destination_name',
  },

  spanKinds: {
    server: 'SPAN_KIND_SERVER',
    client: 'SPAN_KIND_CLIENT',
    producer: 'SPAN_KIND_PRODUCER',
    consumer: 'SPAN_KIND_CONSUMER',
    internal: 'SPAN_KIND_INTERNAL',
  },

  statusCodes: {
    error: 'STATUS_CODE_ERROR',
    ok: 'STATUS_CODE_OK',
    unset: 'STATUS_CODE_UNSET',
  },

  traceQL: {
    serviceName: 'resource.service.name',
    serviceNamespace: 'resource.service.namespace',
  },

  browser: {
    lcp: 'browser_web_vitals_lcp_milliseconds',
    fcp: 'browser_web_vitals_fcp_milliseconds',
    cls: 'browser_web_vitals_cls',
    inp: 'browser_web_vitals_inp_milliseconds',
    ttfb: 'browser_web_vitals_ttfb_milliseconds',
    pageLoads: 'browser_page_loads_total',
    errors: 'browser_errors_total',
    pageLoadDuration: 'browser_page_load_duration_milliseconds_bucket',
    pageRoute: 'page_route',
    browserName: 'browser_name',
  },

  /** Faro telemetry from Grafana Alloy pipeline (loki.process custom metrics). */
  alloyBrowser: {
    lcp: 'loki_process_custom_browser_web_vitals_lcp_milliseconds',
    fcp: 'loki_process_custom_browser_web_vitals_fcp_milliseconds',
    cls: 'loki_process_custom_browser_web_vitals_cls',
    inp: 'loki_process_custom_browser_web_vitals_inp_milliseconds',
    ttfb: 'loki_process_custom_browser_web_vitals_ttfb_milliseconds',
    pageLoads: 'loki_process_custom_browser_page_loads_total',
    errors: 'loki_process_custom_browser_errors_total',
    appLabel: 'app_name',
    job: 'alloy-faro',
    lookback: '30m',
  },

  /** Faro histogram metrics from improved Alloy pipeline. */
  alloyHistogram: {
    lcp: 'faro_web_vitals_lcp_milliseconds',
    fcp: 'faro_web_vitals_fcp_milliseconds',
    cls: 'faro_web_vitals_cls',
    inp: 'faro_web_vitals_inp_milliseconds',
    ttfb: 'faro_web_vitals_ttfb_milliseconds',
    pageLoads: 'faro_page_loads_total',
    errors: 'faro_errors_total',
    sessions: 'faro_sessions_total',
    appLabel: 'app_name',
    envLabel: 'env',
    job: 'alloy-faro',
  },

  /** Faro telemetry stored as structured logs in Loki (logfmt format). */
  faroLoki: {
    // Stream labels
    serviceName: 'service_name',
    kind: 'kind',
    appName: 'app_name',
    // kind= values
    kindMeasurement: 'measurement',
    kindException: 'exception',
    kindEvent: 'event',
    kindLog: 'log',
    // logfmt field names
    typeField: 'type',
    typeWebVitals: 'web-vitals',
    // Vital fields
    fcp: 'fcp',
    lcp: 'lcp',
    cls: 'cls',
    inp: 'inp',
    ttfb: 'ttfb',
    // Context fields
    rating: 'context_rating',
    browserName: 'browser_name',
    pageUrl: 'page_url',
  },
} as const;
