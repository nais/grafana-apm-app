# Metrics Reference

Complete reference for all metrics, labels, dimensions, and query patterns
that the Nais APM app reads. Use this to verify your collector pipelines and
SDK instrumentation.

For datasource setup, authentication, and environment overrides, see
[configuration.md](configuration.md).

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [OpenTelemetry Collector Setup](#opentelemetry-collector-setup)
  - [Span Metrics Connector](#span-metrics-connector)
  - [Service Graph Connector](#service-graph-connector)
  - [Pipeline Wiring](#pipeline-wiring)
- [Auto-Detection & Capabilities](#auto-detection--capabilities)
- [Span Metrics](#span-metrics)
  - [Metric Names](#metric-names)
  - [Labels](#labels)
  - [Span Kind Values](#span-kind-values)
  - [Status Code Values](#status-code-values)
  - [Dimensions (Collector)](#dimensions-collector)
- [Service Graph Metrics](#service-graph-metrics)
- [Endpoint Classification](#endpoint-classification)
- [Resource Attributes](#resource-attributes)
- [Browser / Faro Metrics](#browser--faro-metrics)
  - [Prometheus Source](#prometheus-source)
  - [Loki Source (Structured Logs)](#loki-source-structured-logs)
- [Runtime Metrics](#runtime-metrics)
  - [JVM (Java / Kotlin)](#jvm-java--kotlin)
  - [Node.js](#nodejs)
  - [Go](#go)
  - [Container / Kubernetes](#container--kubernetes)
  - [Database Connection Pools](#database-connection-pools)
  - [Kafka Client](#kafka-client)
- [GraphQL Metrics](#graphql-metrics)
- [Framework Detection](#framework-detection)
- [Traces (Tempo)](#traces-tempo)
- [Logs (Loki)](#logs-loki)
- [PromQL Query Patterns](#promql-query-patterns)

---

## Architecture Overview

```
┌─────────────┐   OTLP    ┌───────────────────┐
│ Application │──────────▶│  OTel Collector    │
│ (SDK)       │  gRPC/HTTP│                    │
└─────────────┘           │  ┌──────────────┐  │     ┌───────┐
                          │  │ spanmetrics  │──┼────▶│ Mimir │ (metrics)
                          │  │ connector    │  │     └───────┘
                          │  └──────────────┘  │
                          │  ┌──────────────┐  │     ┌───────┐
                          │  │ servicegraph │──┼────▶│ Mimir │ (metrics)
                          │  │ connector    │  │     └───────┘
                          │  └──────────────┘  │
                          │                    │     ┌───────┐
                          │  traces ───────────┼────▶│ Tempo │
                          │                    │     └───────┘
                          │  logs ─────────────┼────▶┌───────┐
                          └────────────────────┘     │ Loki  │
                                                     └───────┘
                                                        │
                          ┌────────────────────┐        │
                          │  Grafana + APM App │◀───────┘
                          │  (this plugin)     │◀── Mimir, Tempo
                          └────────────────────┘
```

The APM app reads **derived metrics** (span metrics, service graph) from
Mimir/Prometheus, **traces** from Tempo, and **logs** from Loki. It does not
query raw spans for RED metrics — the OTel Collector must produce them.

---

## OpenTelemetry Collector Setup

The collector needs two connectors to produce the metrics the app expects.

### Span Metrics Connector

The [spanmetrics connector](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/spanmetricsconnector)
converts traces into RED (Rate, Error, Duration) metrics.

```yaml
connectors:
  spanmetrics:
    namespace: traces.span.metrics        # → metric prefix "traces_span_metrics_"
    histogram:
      explicit:
        buckets:
          [2ms, 4ms, 6ms, 8ms, 10ms, 50ms, 100ms, 200ms,
           400ms, 800ms, 1s, 1.4s, 2s, 5s, 10s, 15s]
    dimensions:
      - name: service.namespace
      - name: deployment.environment
      - name: http.method
      - name: http.status_code
      - name: http.route
      - name: rpc.system
      - name: rpc.service
      - name: rpc.method
      - name: peer.service
      - name: db.system
      - name: db.operation
      - name: messaging.system
      - name: messaging.operation
    exemplars:
      enabled: true
    resource_metrics_key_attributes:
      - service.name
      - service.namespace
      - telemetry.sdk.language
```

**Required dimensions** — the app uses all of these for endpoint classification,
dependency detection, and service overview. Removing a dimension will hide the
corresponding protocol tab or feature.

**Namespace** — the app auto-detects the namespace by probing metric names
(see [Auto-Detection](#auto-detection--capabilities)). You can use any
namespace as long as the metrics exist.

### Service Graph Connector

The [servicegraph connector](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/servicegraphconnector)
produces topology metrics showing which services call which.

```yaml
connectors:
  servicegraph:
    latency_histogram_buckets:
      [2ms, 4ms, 6ms, 8ms, 10ms, 50ms, 100ms, 200ms,
       400ms, 800ms, 1s, 1.4s, 2s, 5s, 10s, 15s]
    dimensions:
      - db.system
      - messaging.system
    virtual_node_peer_attributes:
      - peer.service
      - db.name
      - db.system
```

The `virtual_node_peer_attributes` let the graph show external dependencies
(databases, caches, third-party APIs) that don't emit their own traces.

### Pipeline Wiring

Both connectors act as trace consumers **and** metric producers:

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/tempo, spanmetrics, servicegraph]
    metrics:
      receivers: [otlp, spanmetrics, servicegraph]
      processors: [batch]
      exporters: [prometheusremotewrite/mimir]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/loki]
```

**Important:** The Prometheus Remote Write exporter must have
`resource_to_telemetry_conversion: enabled` so resource attributes
(`service.name`, `telemetry.sdk.language`) become metric labels:

```yaml
exporters:
  prometheusremotewrite/mimir:
    endpoint: http://mimir:9009/api/v1/push
    resource_to_telemetry_conversion:
      enabled: true
```

---

## Auto-Detection & Capabilities

On startup (and periodically), the app probes Mimir to detect which metrics
exist. This determines which features are enabled.

### Span Metrics Detection

The app probes the following metric names in order. **First match wins:**

| Candidate | Namespace |
|-----------|-----------|
| `traces_span_metrics_calls_total` | `traces_span_metrics` |
| `traces_spanmetrics_calls_total` | `traces_spanmetrics` |
| `spanmetrics_calls_total` | `spanmetrics` |
| `calls_total` | *(bare)* |

For each namespace, it then probes for the duration metric variant:

| Candidate | Duration Unit |
|-----------|--------------|
| `{ns}_duration_milliseconds_bucket` | `ms` |
| `{ns}_duration_seconds_bucket` | `s` |
| `{ns}_latency_bucket` | `s` |

### Service Graph Detection

| Candidate | Prefix |
|-----------|--------|
| `traces_service_graph_request_total` | `traces_service_graph` |
| `service_graph_request_total` | `service_graph` |

### Manual Override

If auto-detection fails (e.g. restricted Mimir access), you can set the
namespace and duration unit manually in the plugin configuration page.

---

## Span Metrics

### Metric Names

Given a detected namespace `{ns}` (e.g. `traces_span_metrics`):

| Metric | Type | Description |
|--------|------|-------------|
| `{ns}_calls_total` | Counter | Total span count per service/operation |
| `{ns}_duration_milliseconds_bucket` | Histogram | Span duration in milliseconds |
| `{ns}_duration_seconds_bucket` | Histogram | Span duration in seconds (alternative) |

### Labels

These are the Prometheus label names on span metrics after
`resource_to_telemetry_conversion`:

| Label | OTel Attribute | Description |
|-------|---------------|-------------|
| `service_name` | `service.name` | Service name |
| `service_namespace` | `service.namespace` | Namespace / team |
| `span_name` | — | Operation name (e.g. `GET /api/users`) |
| `span_kind` | — | Span classification (see below) |
| `status_code` | — | Span status (see below) |
| `http_method` | `http.method` | HTTP method |
| `http_route` | `http.route` | HTTP route pattern |
| `http_response_status_code` | `http.status_code` | HTTP response code |
| `rpc_service` | `rpc.service` | gRPC service name |
| `rpc_method` | `rpc.method` | gRPC method name |
| `db_system` | `db.system` | Database system (postgres, redis, etc.) |
| `messaging_system` | `messaging.system` | Messaging system (kafka, etc.) |
| `telemetry_sdk_language` | `telemetry.sdk.language` | SDK language (java, go, nodejs, etc.) |
| `k8s_cluster_name` | `deployment.environment` | Deployment environment |
| `le` | — | Histogram bucket boundary |

### Span Kind Values

| Value | Meaning |
|-------|---------|
| `SPAN_KIND_SERVER` | Inbound request handler (HTTP server, gRPC server) |
| `SPAN_KIND_CLIENT` | Outbound request (HTTP client, DB call, gRPC client) |
| `SPAN_KIND_PRODUCER` | Message producer (Kafka, RabbitMQ) |
| `SPAN_KIND_CONSUMER` | Message consumer |
| `SPAN_KIND_INTERNAL` | Internal operation (no network) |

### Status Code Values

| Value | Meaning |
|-------|---------|
| `STATUS_CODE_ERROR` | Span completed with an error |
| `STATUS_CODE_OK` | Span completed successfully (explicitly set) |
| `STATUS_CODE_UNSET` | Status not set by instrumentation |

### Dimensions (Collector)

The spanmetrics connector `dimensions` field determines which span attributes
become metric labels. The APM app needs **all** of the dimensions listed in
the [collector configuration](#span-metrics-connector) to fully classify
endpoints by protocol. Removing a dimension disables the corresponding feature:

| Dimension | Required For |
|-----------|-------------|
| `http.method`, `http.route`, `http.status_code` | HTTP endpoints tab |
| `rpc.service`, `rpc.method` | gRPC endpoints tab |
| `db.system`, `db.operation` | Database endpoints tab |
| `messaging.system`, `messaging.operation` | Messaging endpoints tab |
| `peer.service` | Dependency detection |
| `service.namespace` | Namespace filtering |
| `deployment.environment` | Environment filtering |

---

## Service Graph Metrics

Given a detected prefix `{pfx}` (e.g. `traces_service_graph`):

| Metric | Type | Description |
|--------|------|-------------|
| `{pfx}_request_total` | Counter | Requests between services |
| `{pfx}_request_failed_total` | Counter | Failed requests between services |
| `{pfx}_request_server_seconds_bucket` | Histogram | Server-side latency |

### Labels

| Label | Description |
|-------|-------------|
| `client` | Calling service name |
| `server` | Called service name |
| `connection_type` | Connection type (e.g. database system) |

These metrics power the **Service Map** page, **Callers** panel on the Overview tab,
and the **Dependencies** pages.

---

## Endpoint Classification

The app classifies span metrics into protocol groups based on label presence:

| Protocol | Detection Logic | Labels Used |
|----------|----------------|-------------|
| **HTTP** | `span_kind=SPAN_KIND_SERVER` (default) | `span_name`, `http_method`, `http_route` |
| **gRPC** | `rpc_service!=""` | `rpc_service`, `rpc_method` |
| **Database** | `db_system!=""` | `db_system`, `span_name` |
| **Messaging** | `span_kind=~CONSUMER\|PRODUCER` | `messaging_system`, `span_name`, `span_kind` |
| **Internal** | `span_kind=SPAN_KIND_INTERNAL` | `span_name` |

Each group shows rate, error rate, and p50/p95/p99 duration per operation.

---

## Resource Attributes

| Attribute | Purpose | Required |
|-----------|---------|----------|
| `service.name` | Identifies each service | **Yes** |
| `service.namespace` | Groups services by team/domain (maps to k8s namespace) | Recommended |
| `deployment.environment` | Enables environment filtering | Recommended |
| `telemetry.sdk.language` | Shows SDK language icon next to service names | Optional |
| `http.route` | Produces clean operation names instead of raw URLs | Optional |

### Span Metric Dimensions

For full functionality, span metrics need these dimensions configured
(applies to both Tempo metrics-generator and OTel Collector spanmetrics connector):

| Dimension | Required For |
|-----------|-------------|
| `service.name` | Service identification |
| `service.namespace` | Namespace/team grouping |
| `deployment.environment` | Environment filtering |
| `server.address` | External dependency detection (databases, APIs) |
| `http.status_code` or `http.response.status_code` | Error breakdown |
| `db.system` | Database type detection (postgres, redis, etc.) |
| `db.name` | Database name in dependency view |
| `messaging.system` | Messaging system detection (kafka, rabbitmq) |
| `messaging.destination.name` | Topic/queue names |

### Service Graph Peer Attributes

| Peer Attribute | Purpose |
|----------------|---------|
| `peer.service` | Identifies called service |
| `db.name` | Database dependency naming |
| `db.system` | Database type classification |
| `messaging.destination.name` | Messaging dependency naming |

---

## Browser / Faro Metrics

The app supports two sources for browser telemetry, depending on your
[Grafana Faro](https://grafana.com/oss/faro/) setup.

### Prometheus Source

If Faro metrics are written to Mimir/Prometheus:

| Metric | Type | Description |
|--------|------|-------------|
| `browser_web_vitals_lcp_milliseconds` | Gauge | Largest Contentful Paint |
| `browser_web_vitals_fcp_milliseconds` | Gauge | First Contentful Paint |
| `browser_web_vitals_cls` | Gauge | Cumulative Layout Shift |
| `browser_web_vitals_inp_milliseconds` | Gauge | Interaction to Next Paint |
| `browser_web_vitals_ttfb_milliseconds` | Gauge | Time to First Byte |
| `browser_page_loads_total` | Counter | Total page loads |
| `browser_errors_total` | Counter | Total browser errors |
| `browser_page_load_duration_milliseconds_bucket` | Histogram | Page load duration |

**Labels:** `service_name`, `page_route`, `browser_name`

### Loki Source (Structured Logs)

If Faro data is stored as structured logfmt entries in Loki (e.g. via the
Grafana Alloy/Agent Faro receiver):

**Stream selector:** `{service_name="X", kind="measurement"}`

| Logfmt Field | Description |
|-------------|-------------|
| `type` | Entry type — `web-vitals` for Core Web Vitals |
| `fcp` | First Contentful Paint value |
| `lcp` | Largest Contentful Paint value |
| `cls` | Cumulative Layout Shift value |
| `inp` | Interaction to Next Paint value |
| `ttfb` | Time to First Byte value |
| `context_rating` | Performance rating (good/needs-improvement/poor) |
| `browser_name` | Browser name |
| `page_url` | Page URL |

**Stream kinds:** `measurement`, `exception`, `event`, `log`

The app auto-detects whether Faro data is in Prometheus or Loki by checking
for the `app_name` label in Loki.

---

## Runtime Metrics

Runtime metrics come from **Prometheus scraping** of application metric
endpoints, not from OTel span metrics. They use different labels:

| Label | Description |
|-------|-------------|
| `app` | Application name (from Kubernetes pod label) |
| `namespace` | Kubernetes namespace |

> **Note:** These are `app`/`namespace` (scrape labels), not
> `service_name`/`service_namespace` (OTel resource attributes).

### JVM (Java / Kotlin)

| Metric | Type | Description |
|--------|------|-------------|
| `jvm_memory_used_bytes` | Gauge | Memory used (by `area`: heap, nonheap) |
| `jvm_memory_max_bytes` | Gauge | Maximum memory |
| `jvm_memory_committed_bytes` | Gauge | Committed memory |
| `jvm_gc_duration_seconds` | Histogram | GC pause duration |
| `jvm_gc_overhead` | Gauge | GC overhead ratio (0–1) |
| `jvm_threads_live_threads` | Gauge | Live thread count |
| `jvm_threads_daemon_threads` | Gauge | Daemon thread count |
| `jvm_threads_peak_threads` | Gauge | Peak thread count |
| `jvm_threads_states_threads` | Gauge | Thread count by `state` |
| `jvm_classes_loaded_classes` | Gauge | Loaded class count |
| `jvm_cpu_recent_utilization_ratio` | Gauge | CPU utilization (0–1) |
| `jvm_cpu_count` | Gauge | Available CPU cores |
| `process_uptime_seconds` | Gauge | Process uptime |
| `jvm_buffer_memory_used_bytes` | Gauge | Buffer pool memory used |
| `jvm_buffer_total_capacity_bytes` | Gauge | Buffer pool capacity |
| `jvm_info` | Info | Runtime version (labels: `runtime`, `version`) |

**Additional labels:** `area` (heap/nonheap), `gc` (collector name), `id`
(memory pool), `state` (thread state: runnable, blocked, waiting, etc.)

### Node.js

| Metric | Type | Description |
|--------|------|-------------|
| `nodejs_eventloop_delay_p99_seconds` | Gauge | Event loop delay P99 |
| `nodejs_eventloop_delay_p90_seconds` | Gauge | Event loop delay P90 |
| `nodejs_eventloop_delay_p50_seconds` | Gauge | Event loop delay P50 |
| `nodejs_eventloop_delay_mean_seconds` | Gauge | Event loop mean delay |
| `nodejs_eventloop_utilization_ratio` | Gauge | Event loop utilization (0–1) |
| `nodejs_heap_size_used_bytes` | Gauge | V8 heap used |
| `nodejs_heap_size_total_bytes` | Gauge | V8 heap total |
| `nodejs_external_memory_bytes` | Gauge | External (C++) memory |
| `process_resident_memory_bytes` | Gauge | Resident set size (RSS) |
| `nodejs_gc_duration_seconds` | Histogram | GC duration (by `kind`) |
| `nodejs_active_handles` | Gauge | Active libuv handles |
| `nodejs_active_requests` | Gauge | Active libuv requests |
| `process_cpu_seconds_total` | Counter | CPU time consumed |
| `process_open_fds` | Gauge | Open file descriptors |
| `process_max_fds` | Gauge | Max file descriptors |
| `nodejs_version_info` | Info | Node.js version (label: `version`) |

**Additional labels:** `kind` (GC type: scavenge, mark_sweep_compact)

### Go

| Metric | Type | Description |
|--------|------|-------------|
| `go_goroutines` | Gauge | Active goroutine count |
| `go_threads` | Gauge | OS thread count |
| `go_memstats_alloc_bytes` | Gauge | Allocated heap bytes |
| `go_memstats_sys_bytes` | Gauge | Total memory from OS |
| `go_gc_duration_seconds` | Summary | GC pause duration |
| `go_info` | Info | Go version |
| `process_cpu_seconds_total` | Counter | CPU time consumed |
| `process_open_fds` | Gauge | Open file descriptors |
| `process_max_fds` | Gauge | Max file descriptors |

### Container / Kubernetes

Source: kubelet cAdvisor / kube-state-metrics

| Metric | Type | Description |
|--------|------|-------------|
| `container_cpu_usage_seconds_total` | Counter | CPU time consumed |
| `container_cpu_cfs_throttled_seconds_total` | Counter | CPU throttling |
| `container_memory_usage_bytes` | Gauge | Memory usage |
| `kube_pod_container_resource_requests` | Gauge | Resource requests (label: `resource`) |
| `kube_pod_container_resource_limits` | Gauge | Resource limits (label: `resource`) |
| `kube_pod_container_status_restarts_total` | Counter | Container restarts |
| `kube_deployment_spec_replicas` | Gauge | Desired replica count |

**Additional labels:** `container`, `namespace`, `pod`, `resource`

### Database Connection Pools

**HikariCP** (Spring Boot / Ktor):

| Metric | Type | Description |
|--------|------|-------------|
| `hikaricp_connections_active` | Gauge | Active connections |
| `hikaricp_connections_idle` | Gauge | Idle connections |
| `hikaricp_connections_max` | Gauge | Maximum pool size |
| `hikaricp_connections_pending` | Gauge | Threads waiting for a connection |
| `hikaricp_connections_timeout_total` | Counter | Connection timeout count |
| `hikaricp_connections_usage_seconds` | Histogram | Connection usage duration |

**OTel DB Client** (newer instrumentation):

| Metric | Type | Description |
|--------|------|-------------|
| `db_client_connections_usage` | Gauge | Active connections |
| `db_client_connections_idle_min` | Gauge | Minimum idle connections |
| `db_client_connections_max` | Gauge | Maximum connections |

**Additional labels:** `pool` (connection pool name)

### Kafka Client

| Metric | Type | Description |
|--------|------|-------------|
| `kafka_consumer_records_lag_max` | Gauge | Maximum consumer lag |
| `kafka_consumer_records_consumed_total` | Counter | Records consumed |
| `kafka_producer_records_sent_total` | Counter | Records produced |

**Additional labels:** `topic`, `partition`, `client_id`, `consumer_group`

---

## GraphQL Metrics

The app auto-detects GraphQL frameworks by probing for known metric patterns:

| Framework | Count Metric | Duration Metric | Operation Label |
|-----------|-------------|----------------|-----------------|
| **DGS** (Netflix) | `graphql_request_seconds_count` | `graphql_request_seconds_sum` | `graphql_operation_type` |
| **MicroProfile** | `mp_graphql_seconds_count` | `mp_graphql_seconds_sum` | `name`, `type` |
| Custom (varies) | `graphql_timer_seconds_count` | `graphql_timer_seconds_sum` | `queryName` |

DGS also exposes data-fetcher metrics: `graphql_datafetcher_seconds_count`
and `graphql_datafetcher_seconds_sum`.

---

## PromQL Query Patterns

These are the core query patterns the app uses. `{ns}` is the auto-detected
metric namespace, `[range]` is the time window.

### Request Rate

```promql
sum by (service_name, service_namespace) (
  rate({ns}_calls_total{span_kind="SPAN_KIND_SERVER"}[range])
)
```

### Error Rate

```promql
sum by (service_name, service_namespace) (
  rate({ns}_calls_total{
    span_kind="SPAN_KIND_SERVER",
    status_code="STATUS_CODE_ERROR"
  }[range])
)
```

### P95 Duration

```promql
histogram_quantile(0.95,
  sum by (service_name, service_namespace, le) (
    rate({ns}_duration_milliseconds_bucket{
      span_kind="SPAN_KIND_SERVER"
    }[range])
  )
)
```

### Service Graph Rate

```promql
sum by (client, server, connection_type) (
  rate({pfx}_request_total[range])
)
```

### Faro Web Vital (Loki)

```logql
avg(avg_over_time(
  {service_name="X", kind="measurement"}
  | logfmt
  | type="web-vitals"
  | lcp!=""
  | keep lcp
  | unwrap lcp
  [range]
))
```

### Runtime (JVM Memory)

```promql
avg by (area) (
  avg_over_time(jvm_memory_used_bytes{app="X", namespace="Y"}[range])
)
```

---

## Framework Detection

The app detects application frameworks for display badges in the service inventory:

| Framework | Badge | Detection Metric | When Present |
|-----------|-------|-----------------|--------------|
| **Ktor** | `Ktor` (purple) | `ktor_http_server_requests_seconds_count` | Ktor + Micrometer |
| **Spring Boot** | `Spring` (green) | `application_started_time_seconds` | Spring Boot 3 + Micrometer |
| | | `spring_security_filterchains_access_exceptions_after_total` | Spring Security |
| **Node.js** | `Node.js` (orange) | `nodejs_version_info` | `prom-client` or OTel Node.js SDK |
| **Go** | `Go` (blue) | `go_info` | Default Go Prometheus client |

**Priority:** If multiple detection metrics match (e.g., a Ktor app also has
Spring Boot metrics), the most specific framework wins:
Ktor > Spring Boot > Go > Node.js.

These metrics must be scraped by Prometheus and stored in Mimir for detection
to work. The `app` label on your Prometheus metrics must match the
`service_name` on your OTel span metrics.

---

## Traces (Tempo)

The plugin builds **TraceQL** queries against Tempo to let users search and
browse traces scoped to a specific service.

**Resource attributes used in TraceQL filters:**

| Attribute Path | Purpose |
|---------------|---------|
| `resource.service.name` | Filter traces to a specific service |
| `resource.service.namespace` | Filter traces to a namespace |

**Span attributes used in TraceQL filters:**

| Attribute | Purpose |
|-----------|---------|
| `name` | Span operation name |
| `status` | Span status (`error`, `ok`) |
| `duration` | Span duration |
| `span.http.route` | HTTP route pattern |

Example generated TraceQL:

```
{resource.service.name="my-service" && resource.service.namespace="my-namespace" && status=error && duration >= 500ms}
```

---

## Logs (Loki)

The plugin builds **LogQL** queries against Loki to display structured logs
scoped to a service.

**Stream selectors:**

| Label | Purpose |
|-------|---------|
| `service_name` | Filter logs to a service |
| `service_namespace` | Filter logs to a namespace |
| `level` | Log severity (error, warn, info, debug) |

**Log extraction pipeline:**

```logql
{service_name="my-service"} | level=~"error|warn" | json | line_format `{{ if .message }}{{ .message }}{{ else if .msg }}{{ .msg }}{{ else }}{{ __line__ }}{{ end }}` | drop __error__, __error_details__
```

---
