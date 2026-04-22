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
- **Namespace Overview** — team-level dashboard with aggregate stats, service topology graph (no service limit), services table with search/pagination, and external dependencies
- **RED Dashboards** — per-service Rate, Errors, and Duration panels with configurable percentile selectors (P50–P99) and exemplar overlays linking to traces
- **Operations Breakdown** — top operations table and duration distribution heatmap
- **Dependencies** — downstream dependency inventory with impact scoring, per-dependency RED panels, and operation-level detail including database target (`db_name · db_operation`) and messaging topic breakdowns
- **Connected Services** — inbound/outbound service tables on service detail pages with direct navigation to service or dependency detail
- **Service Map** — topology graph with ELK.js auto-layout showing database, messaging, and external dependency types with error highlighting (per-service and per-namespace scoped)
- **Server Tab** — HTTP, gRPC, and database endpoint breakdowns with protocol-specific metadata
- **Runtime Tab** — container resource utilization, JVM memory pools and GC, Go runtime metrics, Node.js event loop and heap
- **Frontend Tab** — Core Web Vitals (LCP, FCP, CLS, INP, TTFB) with threshold bands, per-page performance table, console errors, enhanced exception drill-down with Explore links, and browser breakdown for Faro-instrumented services
- **Cross-Signal Navigation** — click a spike on any chart to jump straight to the relevant traces or logs in Grafana Explore
- **Trace & Log Exploration** — search and browse traces and logs scoped to a service, with severity and text filters
- **Environment Filtering** — filter all views by deployment environment, with per-environment Tempo/Loki datasource overrides
- **Framework Detection** — automatic badges for Ktor, Spring Boot, Node.js, and Go based on runtime metrics
- **GraphQL Metrics** — auto-detected per-operation rate, latency, and error breakdowns for DGS, MicroProfile, and custom frameworks
- **Zero Config** — auto-detects span metric names, duration units, and available capabilities from your data

![Service Overview](https://raw.githubusercontent.com/nais/grafana-apm-app/main/src/img/screenshot-service-overview.png)
![Server Endpoints](https://raw.githubusercontent.com/nais/grafana-apm-app/main/src/img/screenshot-service-server.png)
![Frontend Observability](https://raw.githubusercontent.com/nais/grafana-apm-app/main/src/img/screenshot-service-frontend.png)

## How it works

The plugin reads **derived metrics** from Mimir/Prometheus — not raw traces.
Your OTel pipeline (Tempo metrics-generator or OTel Collector spanmetrics/servicegraph
connectors) produces pre-aggregated span metrics and service graph metrics that
the plugin queries for dashboards. Traces come from Tempo, logs from Loki.

See [docs/configuration.md](docs/configuration.md) for setup details and
[docs/metrics-reference.md](docs/metrics-reference.md) for the full list of
expected metrics and labels.

## Prerequisites

- **Grafana** >= 12.0.0
- **Mimir** (or Prometheus) with span-derived metrics
- **Tempo** for distributed traces
- **Loki** for logs *(optional — needed for log correlation and Faro frontend data)*

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

For per-environment datasource overrides, authentication setup, and
troubleshooting, see [docs/configuration.md](docs/configuration.md).

## Quick start (development)

```bash
git clone https://github.com/nais/grafana-apm-app.git
cd grafana-apm-app
pnpm install
docker compose up          # Grafana + Mimir + Tempo + Loki + OTel Collector
pnpm run dev               # Frontend watch mode (separate terminal)
```

Open `http://localhost:3000/a/nais-apm-app/services`.

For a demo with realistic traffic from the [OpenTelemetry Demo](https://opentelemetry.io/docs/demo/) microservices:

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
| `mise run clean` | Remove dist/ and coverage/ |

## Architecture

```
src/
├── pages/
│   ├── ServiceInventory.tsx    # Service list with sparklines and health indicators
│   ├── ServiceOverview.tsx     # Per-service RED panels, traces, logs, operations
│   ├── NamespaceOverview.tsx   # Team/namespace page with stats, topology, services
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

**Backend** (`pkg/`) — Go backend plugin that proxies and aggregates queries to
Mimir, Tempo, and Loki. Handles service discovery, capability detection, and
service graph data aggregation.

**Frontend** (`src/`) — React app using `@grafana/scenes` for panel rendering and
`@grafana/ui` for components.

## Documentation

| Document | Contents |
|----------|----------|
| [docs/configuration.md](docs/configuration.md) | Datasource setup, per-environment overrides, authentication, auto-detection |
| [docs/metrics-reference.md](docs/metrics-reference.md) | Complete metrics, labels, dimensions, and query patterns reference |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, code structure, testing, quality gates |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
