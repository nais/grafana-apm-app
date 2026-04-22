# Nais APM

APM for teams that already run the LGTM stack.

If you have OpenTelemetry data flowing into Mimir, Tempo, and Loki, this Grafana
plugin turns it into a full APM experience — service inventory, RED dashboards,
dependency maps, and one-click navigation between metrics, traces, and logs.
No proprietary agents. No cloud lock-in. Just a plugin on top of the stack you
already operate.

![Service Inventory](https://raw.githubusercontent.com/nais/grafana-apm-app/main/src/img/screenshot-service-inventory.png)

## Features

- **Service Inventory** — auto-discovers all instrumented services with health sparklines, SDK language icons, framework badges, sidecar filtering, and sort/filter/search
- **RED Dashboards** — per-service Rate, Errors, and Duration panels with configurable percentile selectors (P50–P99) and exemplar overlays linking to traces
- **Operations Breakdown** — top operations table and duration distribution heatmap
- **Dependencies** — downstream dependency inventory with impact scoring, per-dependency RED panels, and operation-level detail including database target (`db_name · db_operation`) and messaging topic breakdowns
- **Connected Services** — inbound/outbound service tables on service detail pages with direct navigation to service or dependency detail
- **Service Map** — topology graph with ELK.js auto-layout showing database, messaging, and external dependency types with error highlighting
- **Server Tab** — HTTP, gRPC, and database endpoint breakdowns with protocol-specific metadata
- **Runtime Tab** — container resource utilization, JVM memory pools and GC, Go runtime metrics, Node.js event loop and heap
- **Frontend Tab** — Core Web Vitals (LCP, FCP, CLS, INP, TTFB), per-page performance table, and browser breakdown for Faro-instrumented services
- **Cross-Signal Navigation** — click a spike on any chart to jump straight to the relevant traces or logs in Grafana Explore
- **Trace & Log Exploration** — search and browse traces and logs scoped to a service, with severity and text filters
- **Environment Filtering** — filter all views by deployment environment (`k8s.cluster.name`), with per-environment Tempo/Loki datasource overrides
- **Framework Detection** — automatic badges for Ktor, Spring Boot, Node.js, and Go based on runtime metrics
- **Sidecar Filtering** — known sidecars (wonderwall, texas) hidden by default with a toggle to show them
- **GraphQL Metrics** — auto-detected per-operation rate, latency, and error breakdowns for DGS, MicroProfile, and custom frameworks
- **Zero Config** — auto-detects span metric names, duration units, and available capabilities from your data

![Service Overview](https://raw.githubusercontent.com/nais/grafana-apm-app/main/src/img/screenshot-service-overview.png)
![Server Endpoints](https://raw.githubusercontent.com/nais/grafana-apm-app/main/src/img/screenshot-service-server.png)
![Frontend Observability](https://raw.githubusercontent.com/nais/grafana-apm-app/main/src/img/screenshot-service-frontend.png)

## Prerequisites

- **Grafana** >= 12.0.0
- **Mimir** (or Prometheus) with span-derived metrics
- **Tempo** for distributed traces
- **Loki** for logs *(optional — needed for log correlation)*

## Metrics pipeline

The plugin does **not** query traces directly for dashboards. Instead, it reads
pre-aggregated **span metrics** and **service graph metrics** stored in Mimir
(or Prometheus). These metrics can be generated in two ways:

### Option A: Tempo metrics-generator (recommended)

Tempo has a built-in [metrics-generator](https://grafana.com/docs/tempo/latest/metrics-generator/)
that derives metrics from ingested traces and remote-writes them to Mimir.
This is the approach used in production at Nav.

**Required Tempo config:**

```yaml
metricsGenerator:
  enabled: true
  config:
    processor:
      # Span metrics — produces per-service RED metrics
      span_metrics:
        dimensions:
          - service.name
          - service.namespace
          - k8s.cluster.name       # environment filtering
          - server.address          # external dependency detection
          - http.status_code        # error breakdown
          - http.response.status_code
          - db.system               # database dependency detection
          - db.name
          - messaging.system        # Kafka/messaging detection
          - messaging.destination.name
        histogram_buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5]
        filter_policies:
          - include:
              match_type: regex
              attributes:
                - key: kind
                  value: SPAN_KIND_(CLIENT|SERVER|CONSUMER|PRODUCER)

      # Service graphs — produces inter-service dependency metrics
      service_graphs:
        histogram_buckets: [0.1, 0.2, 0.5, 1, 2, 5]
        dimensions:
          - service.name
          - service.namespace
        peer_attributes:
          - peer.service
          - db.name
          - db.system
          - messaging.destination.name
        enable_virtual_node_label: true

    storage:
      remote_write:
        - url: https://your-mimir/api/v1/push
          headers:
            X-Scope-OrgID: your-tenant
```

This produces metrics with the `traces_spanmetrics_` prefix:
- `traces_spanmetrics_calls_total` — request counter
- `traces_spanmetrics_latency_bucket` — duration histogram (seconds)
- `traces_service_graph_request_total` — service-to-service call counter
- `traces_service_graph_request_failed_total` — failed calls
- `traces_service_graph_request_server_seconds_bucket` — inter-service latency

### Option B: OTel Collector connectors

The OTel Collector (or Grafana Alloy) can generate equivalent metrics using
the [spanmetrics](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/spanmetricsconnector)
and [servicegraph](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/servicegraphconnector)
connectors. This is the approach used in the local dev setup.

See [`otel-collector-config.yaml`](https://github.com/nais/grafana-apm-app/blob/main/otel-collector-config.yaml)
for a working example. The key differences from Tempo:
- Metric namespace is configurable (e.g., `traces.span.metrics` → `traces_span_metrics_calls_total`)
- Duration unit can be milliseconds or seconds depending on histogram bucket config
- More histogram buckets for finer-grained latency percentiles

The plugin auto-detects which metric names and duration units are present,
so both approaches work without manual configuration.

### What the plugin auto-detects

On the Configuration page, clicking **Auto-detect capabilities** probes Mimir
for the first matching metric name in this order:

| Probe order | Calls metric | Duration metric | Source |
|-------------|-------------|-----------------|--------|
| 1 | `traces_span_metrics_calls_total` | `*_duration_milliseconds_bucket` or `*_duration_seconds_bucket` | OTel Collector (dotted namespace) |
| 2 | `traces_spanmetrics_calls_total` | `*_latency_bucket` (seconds) | Tempo metrics-generator |
| 3 | `spanmetrics_calls_total` | `*_duration_*_bucket` | OTel Collector (default namespace) |
| 4 | `calls_total` | `*_duration_*_bucket` | OTel Collector (no namespace) |

Service graph detection probes: `traces_service_graph_request_total` → `service_graph_request_total`.

### Runtime and framework metrics (optional)

The plugin also reads **runtime and framework metrics** when available. These
come from application-level instrumentation (OTel SDK or Prometheus client
libraries) and are scraped via Prometheus, not derived from traces.

> **Note:** Runtime metrics use `app`/`namespace` labels (from Prometheus scraping),
> while span metrics use `service_name`/`service_namespace` (from OTel). The plugin
> matches them by name.

**JVM** (source: OTel Java agent auto-instrumentation / Micrometer)

| Metric | Type | Purpose |
|--------|------|---------|
| `jvm_memory_used_bytes` | gauge | Heap / non-heap memory usage (label: `area`) |
| `jvm_memory_max_bytes` | gauge | Max memory per area |
| `jvm_memory_committed_bytes` | gauge | Committed memory per area |
| `jvm_gc_duration_seconds` | histogram | GC pause duration (label: `gc`) |
| `jvm_gc_overhead` | gauge | GC overhead ratio (0–1) |
| `jvm_threads_live_threads` | gauge | Current live threads |
| `jvm_threads_daemon_threads` | gauge | Daemon thread count |
| `jvm_threads_peak_threads` | gauge | Peak thread count |
| `jvm_threads_states_threads` | gauge | Threads by state (label: `state`) |
| `jvm_classes_loaded_classes` | gauge | Loaded class count |
| `jvm_cpu_recent_utilization_ratio` | gauge | CPU utilization (0–1) |
| `jvm_cpu_count` | gauge | Available processors |
| `jvm_buffer_memory_used_bytes` | gauge | Buffer pool usage |
| `jvm_buffer_total_capacity_bytes` | gauge | Buffer pool capacity |
| `jvm_info` | info | JVM runtime and version |
| `process_uptime_seconds` | gauge | Process uptime |

**Node.js** (source: OTel Node.js SDK auto-instrumentation / prom-client)

| Metric | Type | Purpose |
|--------|------|---------|
| `nodejs_eventloop_delay_p99_seconds` | gauge | Event loop P99 latency |
| `nodejs_eventloop_delay_p90_seconds` | gauge | Event loop P90 latency |
| `nodejs_eventloop_delay_p50_seconds` | gauge | Event loop P50 latency |
| `nodejs_eventloop_delay_mean_seconds` | gauge | Event loop mean latency |
| `nodejs_eventloop_utilization_ratio` | gauge | Event loop utilization (0–1) |
| `nodejs_heap_size_used_bytes` | gauge | V8 heap usage |
| `nodejs_heap_size_total_bytes` | gauge | V8 heap total |
| `nodejs_external_memory_bytes` | gauge | External memory (C++ objects) |
| `nodejs_gc_duration_seconds` | histogram | GC pause duration (label: `kind`) |
| `nodejs_active_handles` | gauge | Active libuv handles |
| `nodejs_active_requests` | gauge | Active libuv requests |
| `process_resident_memory_bytes` | gauge | RSS memory |
| `process_cpu_seconds_total` | counter | CPU time consumed |
| `process_open_fds` | gauge | Open file descriptors |
| `process_max_fds` | gauge | Max file descriptors |
| `nodejs_version_info` | info | Node.js version (also used for framework detection) |

**Go** (source: `prometheus/client_golang` default collectors)

| Metric | Type | Purpose |
|--------|------|---------|
| `go_goroutines` | gauge | Active goroutine count |
| `go_threads` | gauge | OS thread count |
| `go_memstats_alloc_bytes` | gauge | Allocated heap bytes |
| `go_memstats_sys_bytes` | gauge | Total memory from OS |
| `go_gc_duration_seconds` | summary | GC pause duration |
| `go_info` | info | Go version |
| `process_cpu_seconds_total` | counter | CPU time consumed |
| `process_open_fds` | gauge | Open file descriptors |
| `process_max_fds` | gauge | Max file descriptors |

**Database connection pools** (source: Micrometer HikariCP / OTel DB client instrumentation)

| Metric | Type | Purpose |
|--------|------|---------|
| `hikaricp_connections_active` | gauge | Active connections per pool |
| `hikaricp_connections_idle` | gauge | Idle connections per pool |
| `hikaricp_connections_max` | gauge | Max pool size |
| `hikaricp_connections_pending` | gauge | Threads waiting for a connection |
| `hikaricp_connections_timeout_total` | counter | Connection timeout count |
| `hikaricp_connections_usage_seconds` | histogram | Connection usage duration |
| `db_client_connections_usage` | gauge | OTel DB active connections |
| `db_client_connections_idle_min` | gauge | OTel DB min idle connections |
| `db_client_connections_max` | gauge | OTel DB max connections |

**Kafka** (source: OTel Java agent auto-instrumentation / JMX Kafka client metrics)

| Metric | Type | Purpose |
|--------|------|---------|
| `kafka_consumer_records_lag_max` | gauge | Max consumer lag per topic/partition |
| `kafka_consumer_records_consumed_total` | counter | Records consumed |
| `kafka_producer_records_sent_total` | counter | Records produced |

Labels: `topic`, `partition`, `client_id`, `consumer_group`

**Container / Kubernetes** (source: kubelet cAdvisor / kube-state-metrics)

| Metric | Type | Purpose |
|--------|------|---------|
| `container_cpu_usage_seconds_total` | counter | CPU time consumed |
| `container_cpu_cfs_throttled_seconds_total` | counter | CPU throttling |
| `container_memory_usage_bytes` | gauge | Memory usage |
| `kube_pod_container_resource_requests` | gauge | Resource requests (label: `resource`) |
| `kube_pod_container_resource_limits` | gauge | Resource limits (label: `resource`) |
| `kube_pod_container_status_restarts_total` | counter | Container restarts |
| `kube_deployment_spec_replicas` | gauge | Desired replica count |

Labels: `container`, `namespace`, `pod`, `resource`

**Framework detection** (used for badges in the service inventory)

| Metric | Source | Detected framework |
|--------|--------|--------------------|
| `ktor_http_server_requests_seconds_count` | Micrometer (Ktor plugin) | Ktor |
| `spring_security_filterchains_*` | Micrometer (Spring Security) | Spring Boot |
| `nodejs_version_info` | prom-client | Node.js |
| `jvm_info` | OTel SDK / Micrometer | JVM (with runtime version) |
| `go_info` | prometheus/client_golang | Go (with version) |

### Browser / Faro Web Vitals (optional)

The plugin supports **frontend observability** via [Grafana Faro](https://grafana.com/oss/faro/).
When Faro is instrumented in a web application, the plugin displays Core Web
Vitals (LCP, FCP, CLS, INP, TTFB), page load counts, and JavaScript error rates.

The plugin tries two data paths and uses the first that has data:

**Path 1 — Mimir (Faro metrics):** When Faro telemetry is exported as Prometheus
metrics (via the Faro receiver or OTel Collector), the plugin reads:

| Metric | Type | Origin |
|--------|------|--------|
| `browser_web_vitals_lcp_milliseconds` | gauge | Faro Web SDK |
| `browser_web_vitals_fcp_milliseconds` | gauge | Faro Web SDK |
| `browser_web_vitals_cls` | gauge | Faro Web SDK |
| `browser_web_vitals_inp_milliseconds` | gauge | Faro Web SDK |
| `browser_web_vitals_ttfb_milliseconds` | gauge | Faro Web SDK |
| `browser_page_loads_total` | counter | Faro Web SDK |
| `browser_errors_total` | counter | Faro Web SDK |
| `browser_page_load_duration_milliseconds_bucket` | histogram | Faro Web SDK |

Labels: `service_name`, `page_route`, `browser_name`

**Path 2 — Loki (Faro structured logs):** When Faro telemetry is stored as
logfmt-formatted log lines in Loki (e.g., via the OTel Collector Loki exporter),
the plugin extracts Web Vitals from log fields using LogQL:

```logql
{service_name="my-app", kind="measurement"} | logfmt | type="web-vitals" | keep lcp | unwrap lcp [$__auto]
```

| Stream label | Values | Purpose |
|-------------|--------|---------|
| `service_name` | app name | Filter by service |
| `kind` | `measurement`, `exception`, `event`, `log` | Telemetry type |

| Logfmt field | Purpose |
|-------------|---------|
| `type` | Event type (`web-vitals`) |
| `fcp`, `lcp`, `cls`, `inp`, `ttfb` | Vital values |
| `context_rating` | Performance rating (`good`, `needs-improvement`, `poor`) |
| `browser_name` | Browser identifier |
| `page_url` | Page URL |

### GraphQL metrics (optional)

The plugin auto-detects GraphQL metrics for services that use GraphQL frameworks.
It probes for known metric naming patterns and displays per-operation rate,
latency, and error breakdowns.

Supported frameworks (auto-detected, first match wins):

| Framework | Count metric | Sum metric | Origin |
|-----------|-------------|------------|--------|
| Netflix DGS | `graphql_request_seconds_count` | `graphql_request_seconds_sum` | Micrometer (DGS Spring Boot) |
| DGS Resolvers | `graphql_datafetcher_seconds_count` | `graphql_datafetcher_seconds_sum` | Micrometer (DGS datafetchers) |
| MicroProfile GraphQL | `mp_graphql_seconds_count` | `mp_graphql_seconds_sum` | Eclipse MicroProfile |
| Custom (per-query) | `graphql_{QueryName}_seconds_count` | `graphql_{QueryName}_seconds_sum` | App-specific Prometheus client |

These metrics are **not** from OTel auto-instrumentation — they come from
framework-level Prometheus client libraries (Micrometer, MicroProfile, or
custom app instrumentation). Labels used: `app`, `namespace`.

### Recommended resource attributes

| Attribute | Purpose | Required |
|-----------|---------|----------|
| `service.name` | Identifies each service | **Yes** |
| `service.namespace` | Groups services by team/domain (maps to k8s namespace) | Recommended |
| `k8s.cluster.name` | Enables environment filtering | Recommended |
| `telemetry.sdk.language` | Shows SDK language icon next to service names | Optional |
| `http.route` | Produces clean operation names instead of raw URLs | Optional |

### Span metric dimensions

For full functionality, span metrics need these dimensions configured
(applies to both Tempo metrics-generator and OTel Collector spanmetrics connector):

| Dimension | Purpose |
|-----------|---------|
| `service.name` | **Required.** Service identification |
| `service.namespace` | **Required.** Namespace/team grouping |
| `k8s.cluster.name` | Environment filtering |
| `server.address` | External dependency detection (databases, APIs) |
| `http.status_code` or `http.response.status_code` | Error breakdown |
| `db.system` | Database type detection (postgres, redis, etc.) |
| `db.name` | Database name in dependency view |
| `messaging.system` | Messaging system detection (kafka, rabbitmq) |
| `messaging.destination.name` | Topic/queue names |

For service graph metrics, these peer attributes enable dependency detection:

| Peer attribute | Purpose |
|----------------|---------|
| `peer.service` | Identifies called service |
| `db.name` | Database dependency naming |
| `db.system` | Database type classification |
| `messaging.destination.name` | Messaging dependency naming |

### Traces (Tempo)

The plugin builds **TraceQL** queries against Tempo to let users search and
browse traces scoped to a specific service. Trace queries are constructed on
the frontend using Grafana Scenes and link directly to Tempo Explore.

**Resource attributes used in TraceQL filters:**

| Attribute path | Purpose |
|---------------|---------|
| `resource.service.name` | Filter traces to a specific service |
| `resource.service.namespace` | Filter traces to a namespace |

**Span attributes used in TraceQL filters:**

| Attribute | Purpose | Origin |
|-----------|---------|--------|
| `name` | Span operation name | OTel SDK (all languages) |
| `status` | Span status (`error`, `ok`) | OTel SDK (all languages) |
| `duration` | Span duration | OTel SDK (all languages) |
| `span.http.route` | HTTP route pattern | OTel HTTP auto-instrumentation |

Example generated TraceQL query:

```
{resource.service.name="my-service" && resource.service.namespace="my-namespace" && status=error && duration >= 500ms}
```

### Logs (Loki)

The plugin builds **LogQL** queries against Loki to display structured logs
scoped to a service. Log panels support severity filtering and text search.

**Stream selectors:**

| Label | Purpose | Origin |
|-------|---------|--------|
| `service_name` | Filter logs to a service | OTel resource attribute (mapped by Loki exporter) |
| `service_namespace` | Filter logs to a namespace | OTel resource attribute |
| `level` | Log severity (error, warn, info, debug) | OTel severity / structured log field |

**Log extraction pipeline:**

The plugin auto-parses JSON-formatted logs and extracts the message field:

```logql
{service_name="my-service"} | level=~"error|warn" | json | line_format `{{ if .message }}{{ .message }}{{ else if .msg }}{{ .msg }}{{ else }}{{ __line__ }}{{ end }}` | drop __error__, __error_details__
```

This supports both `.message` (standard) and `.msg` (common alternative) field
names, falling back to the raw log line.

## Framework / app type detection

The service list shows a **type badge** (Ktor, Spring, Node.js, Go) next to
services where the framework can be automatically detected from Prometheus
metrics. Detection works by looking for well-known metrics scraped from your
application pods.

| Framework | Badge | Detection metric | When present |
|-----------|-------|-----------------|--------------|
| **Ktor** | `Ktor` (purple) | `ktor_http_server_requests_seconds_count` | Always, when using Ktor + Micrometer |
| **Spring Boot** | `Spring` (green) | `application_started_time_seconds` | Always, in Spring Boot 3 + Micrometer |
| | | `spring_security_filterchains_access_exceptions_after_total` | Only with Spring Security + exceptions |
| **Node.js** | `Node.js` (orange) | `nodejs_version_info` | Always, with `prom-client` or OTel Node.js SDK |
| **Go** | `Go` (blue) | `go_info` | Always, with default Go Prometheus client |

**Why does my service not show a badge?**

1. **No Prometheus scraping** — the detection metrics come from application-emitted
   Prometheus metrics (not OTel span metrics). Your pod must be scraped by
   Prometheus with `app` and `namespace` labels.
2. **Missing instrumentation library** — for JVM apps, you need Micrometer on the
   classpath (typically included via Spring Boot Actuator or Ktor metrics plugin).
   For Node.js, `prom-client` or the OpenTelemetry Prometheus exporter. For Go,
   the standard `prometheus/client_golang`.
3. **Label mismatch** — the `app` label on your Prometheus metrics must match the
   `service_name` on your OTel span metrics. In Nais, both default to the
   application name from `nais.yaml`.

**Priority:** If multiple detection metrics match (e.g., a Ktor app also has
Spring Boot metrics), the most specific framework wins:
Ktor > Spring Boot > Go > Node.js.

## Installation

Install the plugin in your Grafana instance:

```sh
grafana-cli plugins install nais-apm-app
```

Or set it as an environment variable for Docker deployments:

```sh
GF_INSTALL_PLUGINS=nais-apm-app
```

Then enable the plugin under **Administration > Plugins** in Grafana.

## Configuration

1. Go to the plugin's **Configuration** page
2. Enter data source UIDs for Mimir, Tempo, and Loki
3. Click **Auto-detect capabilities** to verify connectivity and detect metric names
4. Save

### Data sources

| Setting | Purpose | Default |
|---------|---------|---------|
| Metrics (Prometheus/Mimir) UID | Mimir or Prometheus instance with span metrics | *(required)* |
| Traces (Tempo) UID | Default Tempo instance | *(required)* |
| Logs (Loki) UID | Default Loki instance | *(optional)* |

### Per-environment datasource overrides

If you run separate Tempo/Loki instances per environment (e.g., `dev-gcp`,
`prod-gcp`), you can configure per-environment overrides. When a user selects
an environment filter, trace and log links will route to the matching
datasource instead of the default.

Each override maps an environment name (matching `deployment.environment`) to
a Tempo UID and/or Loki UID.

### Detection and overrides

| Setting | Purpose | Default |
|---------|---------|---------|
| Metric namespace | Span metrics prefix (e.g., `traces_span_metrics`) | Auto-detected |
| Duration unit | `ms` or `s` — depends on your OTel Collector config | Auto-detected |

The **Auto-detect** button probes your metrics backend for known span metric
naming patterns and reports what it found: namespace, duration unit, and
number of discovered services. Manual overrides are only needed when
auto-detection fails or when running non-standard pipelines.

### Authentication

When Grafana runs behind an OAuth2 proxy (e.g., Wonderwall on Nais), the
plugin backend cannot use forwarded browser cookies for internal API calls
because the cookies belong to the proxy, not to Grafana itself.

**Option 1 — Auto-managed (recommended, Grafana 10.3+):**

Enable Grafana's `externalServiceAccounts` feature toggle and set
`auth.managed_service_accounts_enabled = true` in `grafana.ini`. The plugin
will automatically receive a managed service account token — no manual
configuration needed.

**Option 2 — Manual service account token:**

1. Go to **Administration > Service accounts** and create a new account
2. Assign **Viewer** role (only read access to datasources is needed)
3. Generate a token (starts with `glsa_`)
4. Paste it into the **Grafana Service Account Token** field on the plugin configuration page

**Auth is not needed** for local development with anonymous auth or when
Grafana handles authentication directly (no OAuth2 proxy in front).

The plugin uses a 3-tier fallback: auto-managed token → manual token → forwarded user headers.

## Development

### Quick start

```bash
git clone https://github.com/nais/grafana-apm-app.git
cd grafana-apm-app
pnpm install
```

Start the full development stack (Grafana + Mimir + Tempo + Loki + OTel Collector):

```bash
docker compose up
```

In a separate terminal, run the frontend in watch mode:

```bash
pnpm run dev
```

Open `http://localhost:3000/a/nais-apm-app/services`.

To build the backend:

```bash
mise run backend:build
```

### Demo environment

A demo setup with the [OpenTelemetry Demo](https://opentelemetry.io/docs/demo/) microservices
generating realistic traffic:

```bash
docker compose -f docker-compose.demo.yaml up
```

### Commands

The project uses [mise](https://mise.jdx.dev/) as task runner:

| Command | Description |
|---------|-------------|
| `mise run all` | Full check + test + build pipeline |
| `mise run check` | Lint + typecheck + format (frontend & backend) |
| `mise run test` | All tests (Jest + Go with race detector) |
| `mise run build` | Production build (frontend + backend) |
| `mise run dev` | Docker stack + frontend watch mode |
| `mise run deploy` | Build all + restart Grafana |
| `mise run deploy:up` | Start full local stack |
| `mise run deploy:down` | Stop local stack |
| `mise run deploy:demo` | Start stack with OTel Demo traffic |
| `mise run clean` | Remove dist/ and coverage/ |
| `pnpm run e2e` | Playwright end-to-end tests |

### Requirements

- Node.js 22 (see [`.nvmrc`](https://github.com/nais/grafana-apm-app/blob/main/.nvmrc))
- Go 1.25+
- Docker

## Architecture

The plugin has a Go backend and a React frontend.

**Backend** (`pkg/`) — Grafana backend plugin that proxies and aggregates queries to
Mimir, Tempo, and Loki. Handles service discovery, capability detection, and service
graph data aggregation.

**Frontend** (`src/`) — React app using `@grafana/scenes` for panel rendering and
`@grafana/ui` for components.

```
src/
├── pages/
│   ├── ServiceInventory.tsx    # Service list with sparklines and health indicators
│   ├── ServiceOverview.tsx     # Per-service RED panels, traces, logs, operations
│   ├── ServiceMap.tsx          # Topology graph
│   ├── Dependencies.tsx        # Downstream dependency inventory
│   ├── DependencyDetail.tsx    # Per-dependency RED panels and operation breakdown
│   └── tabs/                   # Tab components for service detail
│       ├── ServerTab.tsx       # HTTP/gRPC/DB endpoint breakdown
│       ├── RuntimeTab.tsx      # Container, JVM, Go, Node.js runtime metrics
│       ├── FrontendTab.tsx     # Web Vitals, page performance, browser breakdown
│       ├── DependenciesTab.tsx # Per-service dependency list
│       ├── TracesTab.tsx       # Trace search and exploration
│       └── LogsTab.tsx         # Log viewer with severity filtering
├── components/
│   ├── AppConfig/              # Plugin configuration page
│   └── ServiceGraph/           # React Flow service map with ELK.js layout
├── api/
│   └── client.ts               # TypeScript API client for the Go backend
└── utils/                      # Query builders, formatters, constants
```

## Contributing

See [CONTRIBUTING.md](https://github.com/nais/grafana-apm-app/blob/main/CONTRIBUTING.md).

## License

[Apache-2.0](https://github.com/nais/grafana-apm-app/blob/main/LICENSE)
