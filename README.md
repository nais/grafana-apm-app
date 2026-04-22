# Nais APM

APM for teams that already run the LGTM stack.

If you have OpenTelemetry data flowing into Mimir, Tempo, and Loki, this Grafana
plugin turns it into a full APM experience — service inventory, RED dashboards,
dependency maps, and one-click navigation between metrics, traces, and logs.
No proprietary agents. No cloud lock-in. Just a plugin on top of the stack you
already operate.

![Service Inventory](https://raw.githubusercontent.com/nais/grafana-apm-app/main/src/img/screenshot-service-inventory.png)

## Features

- **Service Inventory** — auto-discovers all instrumented services with health sparklines, SDK language icons, and sort/filter
- **RED Dashboards** — per-service Rate, Errors, and Duration panels with percentile selectors and exemplar overlays
- **Operations Breakdown** — top operations table and duration distribution histogram
- **Service Map** — topology graph showing how your services call each other
- **Cross-Signal Navigation** — click a spike on any chart to jump straight to the relevant traces or logs
- **Trace & Log Exploration** — search and browse traces and logs scoped to a service
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

### Additional metrics (optional)

The plugin also reads **runtime and framework metrics** when available. These
come from application-level instrumentation (OTel SDK or Prometheus client
libraries) and are scraped via Prometheus, not derived from traces.

| Metric family | Labels used | Source | Plugin feature |
|--------------|------------|--------|---------------|
| `jvm_memory_used_bytes`, `jvm_gc_duration_seconds`, `jvm_threads_*` | `app`, `namespace` | OTel SDK / Micrometer | Runtime tab (JVM) |
| `nodejs_eventloop_delay_*`, `nodejs_heap_size_*` | `app`, `namespace` | OTel SDK / prom-client | Runtime tab (Node.js) |
| `go_goroutines`, `go_memstats_*` | `app`, `namespace` | Go runtime | Runtime tab (Go) |
| `hikaricp_connections_*`, `db_client_connections_*` | `app`, `namespace` | OTel SDK / Micrometer | Runtime tab (DB pools) |
| `kafka_consumer_records_lag_max`, `kafka_producer_*` | `app`, `namespace` | OTel SDK / JMX | Runtime tab (Kafka) |
| `container_cpu_usage_seconds_total`, `kube_pod_*` | `namespace`, `pod` | kubelet / kube-state-metrics | Runtime tab (Container) |
| `ktor_http_server_requests_seconds_count` | `app`, `namespace` | Micrometer | Framework detection (badge) |
| `spring_security_filterchains_*` | `app`, `namespace` | Micrometer | Framework detection (badge) |
| `nodejs_version_info` | `app`, `namespace` | prom-client | Framework detection (badge) |

> **Note:** Runtime metrics use `app`/`namespace` labels (from Prometheus scraping),
> while span metrics use `service_name`/`service_namespace` (from OTel). The plugin
> matches them by name.

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
mage -v build:linux
```

### Demo environment

A demo setup with the [OpenTelemetry Demo](https://opentelemetry.io/docs/demo/) microservices
generating realistic traffic:

```bash
docker compose -f docker-compose.demo.yaml up
```

### Commands

| Command | Description |
|---------|-------------|
| `pnpm run dev` | Frontend watch mode |
| `pnpm run build` | Production frontend build |
| `pnpm run test` | Unit tests (watch mode) |
| `pnpm run test:ci` | Unit tests (CI) |
| `pnpm run typecheck` | TypeScript type checking |
| `pnpm run lint` | ESLint |
| `pnpm run lint:fix` | Auto-fix lint and format |
| `pnpm run e2e` | Playwright end-to-end tests |
| `mage -v build:linux` | Backend build (Go) |

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
│   └── ServiceMap.tsx          # Topology graph
├── components/
│   └── AppConfig/              # Plugin configuration page
├── api/
│   └── client.ts               # TypeScript API client for the Go backend
└── utils/                      # Query builders, formatters, constants
```

## Contributing

See [CONTRIBUTING.md](https://github.com/nais/grafana-apm-app/blob/main/CONTRIBUTING.md).

## License

[Apache-2.0](https://github.com/nais/grafana-apm-app/blob/main/LICENSE)
