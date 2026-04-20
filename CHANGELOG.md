# Changelog

## 0.1.0 (2026-04-20)

First public release of Application Observability for Grafana — a self-hosted APM plugin
powered by OpenTelemetry data from Mimir, Loki, and Tempo.

### Features

- **Service Inventory** — auto-discovered table of all instrumented services with health
  sparklines, SDK language icons, namespace/environment filters, search, sort, and pagination
- **Service Overview** — per-service RED panels (Rate, Errors, Duration) with configurable
  percentile selectors (P50/P75/P90/P95/P99) and exemplar overlays
- **Operations Breakdown** — top operations table and duration distribution histogram
- **Service Map** — topology graph showing inter-service dependencies with error highlighting
- **Dependencies** — downstream dependency inventory with impact scoring, upstream callers,
  and per-dependency operation breakdown
- **Connected Services** — inbound/outbound service tables on service detail pages
- **Cross-Signal Navigation** — click any data point to jump to correlated traces or logs
  in Grafana Explore
- **Trace Exploration** — search and browse traces scoped to a service with status filtering
- **Log Exploration** — service-scoped log viewer with severity filtering, text search,
  and log volume histogram
- **Server Tab** — HTTP/gRPC/database endpoint breakdown with protocol-specific metadata
- **Frontend Tab** — Core Web Vitals (LCP, FCP, CLS, INP, TTFB), page load trends,
  per-page performance table, browser breakdown, and duration histogram for Faro-instrumented
  services
- **Auto-Detection** — automatically discovers span metric names, duration units, and
  available capabilities from your data
- **Capability-Driven UI** — tabs and panels only appear when the underlying data exists
- **Environment Filter** — filter all views by deployment environment

### Security

- PromQL label value sanitization on both backend (Go) and frontend (TypeScript)
- Input validation with allowlists on all user-controlled query parameters
- HTTP method enforcement on all API endpoints
- Bounded response reading (10 MB limit) to prevent OOM from large Prometheus responses

### Technical

- Go backend using Grafana Plugin SDK with datasource proxy integration
- React frontend using @grafana/scenes for panel rendering
- Grafana >= 12.0.0 required
- Apache 2.0 license
