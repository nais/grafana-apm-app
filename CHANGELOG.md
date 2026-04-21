# Changelog

## 0.1.1 (2026-04-21)

### Bug Fixes

- **Cache**: Hard limit prevents unbounded memory growth past maxSize
- **Cache**: Add org ID to cache keys to prevent cross-tenant data leaks
- **Cache**: Lazy cleanup of expired entries on read
- **PromQL**: Use `regexp.QuoteMeta` instead of `url.PathEscape` for regex escaping

### Performance

- **Runtime**: Limit query fan-out to 3 concurrent categories (~30 peak queries)
- **Frontend**: Vitals queries run in parallel instead of sequentially
- **Service Graph**: ELK layout skipped for graphs over 300 nodes (grid fallback)
- **Service Graph**: Proper `setTimeout` cleanup in useEffect
- **Health Checks**: Shared HTTP client for connection reuse
- **Health Checks**: Drain response body to prevent connection pool leaks
- **Capabilities**: Reduce detached context timeout from 60s to 30s

### CI

- Bump grafana/plugin-actions to v1.1.0
- Bump magefile/mage-action to v4.0.0
- Bump actions/setup-node to v6.4.0

## 0.1.0 (2026-04-20)

First public release of Nais APM — a self-hosted APM plugin
powered by OpenTelemetry data from Mimir, Loki, and Tempo.

### Features

- **Service Inventory** — auto-discovered table of all instrumented services with health
  sparklines, SDK language icons, namespace/environment filters, search, sort, and pagination
- **Service Overview** — per-service RED panels (Rate, Errors, Duration) with configurable
  percentile selectors (P50/P75/P90/P95/P99) and exemplar overlays
- **Operations Breakdown** — top operations table and duration distribution histogram
- **Service Map** — topology graph showing inter-service dependencies with error highlighting,
  collapsible dormant nodes, and ELK.js auto-layout
- **Dependencies** — downstream dependency inventory with impact scoring, upstream callers,
  per-dependency operation breakdown, and RED time-series panels on detail pages
- **Connected Services** — inbound/outbound service tables on service detail pages
- **Cross-Signal Navigation** — click any data point to jump to correlated traces or logs
  in Grafana Explore; clickable endpoint rows navigate to filtered traces
- **Trace Exploration** — search and browse traces scoped to a service with status filtering
- **Log Exploration** — service-scoped log viewer with severity filtering, text search,
  and log volume histogram
- **Server Tab** — HTTP/gRPC/database endpoint breakdown with protocol-specific metadata
- **Frontend Tab** — Core Web Vitals (LCP, FCP, CLS, INP, TTFB), P75 trends, per-page
  performance table, browser breakdown, and duration histogram for Faro-instrumented services
- **Runtime Tab** — container resource utilization, Go runtime metrics, JVM memory pools,
  GC types, and thread counts
- **Auto-Detection** — automatically discovers span metric names, duration units, and
  available capabilities from your data
- **Capability-Driven UI** — tabs and panels only appear when the underlying data exists
- **Environment Filter** — filter all views by deployment environment
- **Deep Linking** — tab selection and filter state persisted in URL via `?tab=` params

### Security

- PromQL label value sanitization on both backend (Go) and frontend (TypeScript)
- Input validation with allowlists on all user-controlled query parameters
- TraceQL query escaping for service names and search terms
- HTTP method enforcement on all API endpoints
- Bounded response reading (10 MB limit) to prevent OOM from large Prometheus responses
- Security vulnerability patches for transitive dependencies (protobufjs, dompurify,
  immutable, serialize-javascript)

### Technical

- Go backend using Grafana Plugin SDK with datasource proxy integration
- React frontend using @grafana/scenes for panel rendering
- Grafana >= 12.0.0 required (tested on 12.0–12.4 and 13.0–13.1)
- E2E tests across 6 Grafana versions including Grafana 13 carousel overlay handling
- CI pipeline with plugin validator, Playwright reports published to GitHub Pages
- Apache 2.0 license
