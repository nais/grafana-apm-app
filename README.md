# Nais APM

APM for teams that already run the LGTM stack. This is the **Legend** release
of Nais APM.

If you have OpenTelemetry data flowing into Mimir, Tempo, and Loki, this Grafana
plugin turns it into a full APM experience — service inventory, RED dashboards,
dependency maps, and one-click navigation between metrics, traces, and logs.
No proprietary agents. No cloud lock-in. Just a plugin on top of the stack you
already operate.

![Service Inventory](https://raw.githubusercontent.com/nais/grafana-apm-app/main/src/img/screenshot-service-inventory.png)

## Features

### Error tracking

- **Issues** — frontend _and_ backend errors grouped by a stable, owned fingerprint (versioned, computed query-time, HA-safe) so dynamic message content doesn't splinter issues; source badges, occurrence/session counts, faceted search (version/browser/page)
- **Triage** — resolve / ignore / assign / mute with regression detection ("did this come back after the latest deploy?"), stored HA-safe as an append-only annotation event log (no plugin database — see [docs/adr/0001](docs/adr/0001-state-in-grafana-shared-db.md))
- **Exception drawer** — real stack traces (console-capture frames de-polluted), in-app frame highlighting, breadcrumbs, deep links to traces/logs, and joined user feedback
- **Session replay & crash snapshots** — opt-in rrweb recording with a non-overridable privacy masking floor, self-hosted player in the drawer
- **Alerting** — pre-filled Grafana alert rules for error-rate, exception spikes, web-vitals, new/regressed exceptions, and SLO burn-rate
- **Releases** — adoption %, error-free rate, and deploy-marker enrichment per app version

### Observability breadth

- **Overview** — instant health header (RED with baseline deltas vs the previous period) + service scorecard (observability-readiness score and ownership)
- **Database** — query analytics from span metrics (rate/error/p95 per operation and host) plus connection-pool health, with an instrumentation-requirements empty state
- **Log patterns** — top error patterns from Loki's pattern ingester with new-pattern detection (the incident-triage view)
- **Trace analytics** — TraceQL-metrics breakdowns ("which attribute explains the p99")
- **SLO / error budgets** — 30-day compliance, remaining-budget bar, and current burn rate with a target selector
- **Backend** — merges Endpoints (RED — rate/errors/duration per operation) with Runtime (container resources, JVM/Go/Node internals) in one server-side view
- **Frontend** — Core Web Vitals with threshold bands, per-page performance, web-vitals attribution, and a compact browser-scoped issues row
- **User feedback** _(preview — internal pilot only)_ — `@nais/apm` `captureFeedback` joined to issues in the drawer; free-text into shared Loki, so gated on the personvernombud process and a no-personal-information input warning
- **Jobs** — CronJob/Naisjob monitoring from kube-state-metrics (schedule, last run, failure streak)
- **Profiling** — Pyroscope flame graphs, capability-gated (appears only when a Pyroscope datasource exists)

### Topology & navigation

- **Service Inventory / Namespace Overview** — auto-discovery with health sparklines, framework badges, fuzzy search
- **Service Map** — namespace-clustered global topology (drills down to per-namespace maps) + per-service graphs with error highlighting; Mermaid export
- **Dependencies & Operations** — upstream callers, downstream dependencies with impact scoring, and per-protocol endpoint breakdowns (HTTP/gRPC/db/messaging/GraphQL) with click-through to traces
- **Global time picker** — one time range and refresh in the page header, shared across every tab
- **Cross-signal navigation** — click any spike to jump to the relevant traces or logs in Explore
- **Environment filtering** — per-environment Tempo/Loki datasource overrides
- **Zero config** — auto-detects span metric names, duration units, and available capabilities from your data

![Service Overview](https://raw.githubusercontent.com/nais/grafana-apm-app/main/src/img/screenshot-service-overview.png)
![Server Endpoints](https://raw.githubusercontent.com/nais/grafana-apm-app/main/src/img/screenshot-service-server.png)
![Frontend Observability](https://raw.githubusercontent.com/nais/grafana-apm-app/main/src/img/screenshot-service-frontend.png)

## How it works

The plugin reads **derived metrics** from Mimir/Prometheus — not raw traces.
Your OTel pipeline (Tempo metrics-generator or OTel Collector spanmetrics/servicegraph
connectors) produces pre-aggregated span metrics and service graph metrics that
the plugin queries for dashboards. Traces come from Tempo, logs from Loki.

See [docs/configuration.md](https://github.com/nais/grafana-apm-app/blob/main/docs/configuration.md) for setup details and
[docs/metrics-reference.md](https://github.com/nais/grafana-apm-app/blob/main/docs/metrics-reference.md) for the full list of
expected metrics and labels.

## Prerequisites

- **Grafana** >= 12.0.0
- **Mimir** (or Prometheus) with span-derived metrics
- **Tempo** for distributed traces
- **Loki** for logs _(optional — needed for log correlation, Faro frontend data, issues/triage, and log patterns)_
- **nais API (Console) token** _(optional — needed for deploy/release tracking, regression detection, and the service scorecard's ownership card)_. See [Platform dependencies](#platform-dependencies) below; without it those features degrade silently (deploy markers/scorecard ownership simply don't appear).
- **Loki pattern ingester** _(optional — enables the Log Patterns view; the plugin falls back to client-side sampling when it's off)_
- **kube-state-metrics** exposed to tenant Grafana _(optional — powers the Jobs page; the page hides itself when the metrics aren't present)_
- **Pyroscope** datasource _(optional — the Profiling tab appears only when one is configured)_

### Platform dependencies

Several features reach the **nais API (Console) GraphQL endpoint** from the
plugin backend, authenticated with a bearer token:

- **Deploy/release tracking & regression detection** (`naissync.go`) — polls
  Console for deployments and writes deploy annotations.
- **Service scorecard ownership card** (`scorecard.go`) — resolves team, Slack
  channel, repo, and ingress URLs.

This requires two things in the platform:

1. **A Console API URL + token.** Set these either on the plugin **Configuration
   page** (the "nais API (optional)" fieldset) or via Grafana **provisioning**
   (`jsonData.naisApiUrl` + `secureJsonData.naisApiToken`). Both features are
   gated on the token and no-op cleanly when it is absent.
2. **Network policy (netpol) egress from the Grafana workload** to the nais API
   host. On nais this means an outbound-access rule allowing Grafana to reach
   the Console API endpoint; without it the backend's HTTPS calls time out and
   the dependent features stay empty (they never block the rest of the plugin).

See [infra/README.md](infra/README.md) for the full platform-dependency list
and [docs/adr/0001](docs/adr/0001-state-in-grafana-shared-db.md) for why triage
state needs Grafana annotation retention kept at keep-forever.

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
2. Enter datasource UIDs for Mimir, Tempo, and Loki
3. Click **Auto-detect capabilities** to verify connectivity and detect metric names
4. Save
5. _(Optional)_ To enable deploy/release tracking and the scorecard ownership
   card, fill the **nais API (optional)** fieldset (URL + token) — or provision
   `jsonData.naisApiUrl` / `secureJsonData.naisApiToken` — and ensure netpol
   egress from Grafana to the nais API host (see [Platform dependencies](#platform-dependencies))

For per-environment datasource overrides, authentication setup, and
troubleshooting, see [docs/configuration.md](https://github.com/nais/grafana-apm-app/blob/main/docs/configuration.md).

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

| Command           | Description                                    |
| ----------------- | ---------------------------------------------- |
| `mise run all`    | Full check + test + build pipeline             |
| `mise run check`  | Lint + typecheck + format (frontend & backend) |
| `mise run test`   | All tests (Jest + Go with race detector)       |
| `mise run build`  | Production build (frontend + backend)          |
| `mise run dev`    | Docker stack + frontend watch mode             |
| `mise run deploy` | Build all + restart Grafana                    |
| `mise run clean`  | Remove dist/ and coverage/                     |

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
│       ├── ServerTab.tsx       # Operations: HTTP/gRPC/DB/client endpoint breakdown
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

**User docs** live on the Nais documentation site under
[doc.nais.io/observability/apm](https://doc.nais.io/observability/apm/) — how to
instrument, triage issues, create alerts, enable session replay, and collect
user feedback. Start with the
[Get started tutorial](https://doc.nais.io/observability/apm/tutorials/get-started/)
or [Track frontend errors](https://doc.nais.io/observability/apm/tutorials/track-frontend-errors/).

**Frontend SDK:** the [`@nais/apm`](https://github.com/nais/apm) client
instruments browser apps for the Frontend tab (errors, session replay, user
feedback) — see the [client API reference](https://doc.nais.io/observability/apm/reference/apm-client-api/).

**Operator/developer docs** for this repo:

| Document                                                                                                 | Contents                                                                    |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [docs/configuration.md](https://github.com/nais/grafana-apm-app/blob/main/docs/configuration.md)         | Datasource setup, per-environment overrides, authentication, auto-detection |
| [docs/metrics-reference.md](https://github.com/nais/grafana-apm-app/blob/main/docs/metrics-reference.md) | Complete metrics, labels, dimensions, and query patterns reference          |
| [CONTRIBUTING.md](https://github.com/nais/grafana-apm-app/blob/main/CONTRIBUTING.md)                     | Development setup, code structure, testing, quality gates                   |
| [CHANGELOG.md](https://github.com/nais/grafana-apm-app/blob/main/CHANGELOG.md)                           | Release history                                                             |

## Contributing

See [CONTRIBUTING.md](https://github.com/nais/grafana-apm-app/blob/main/CONTRIBUTING.md).

## License

[Apache-2.0](https://github.com/nais/grafana-apm-app/blob/main/LICENSE)
