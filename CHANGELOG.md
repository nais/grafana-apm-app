# Changelog

## 0.3.0 (2026-04-22)

### Features

- **Sidecar Filtering**: Sidecars (wonderwall, texas) are identified and hidden by default in the service inventory with a toggle to show them. Sidecar badges and visual de-emphasis in connected services and service map views.
- **Framework Detection**: Improved detection for Go (`go_info`) and Spring Boot (`application_started_time_seconds`). Node.js correctly takes priority over Go when both metrics are present. Sidecar containers (wonderwall, texas) are excluded from Go detection — they share the pod's `app` label, which falsely marked Node.js apps as Go.
- **Environment Grouping**: When filtering by namespace, services are automatically grouped by environment with visual section headers — helps teams see their apps across prod/dev/staging.
- **Namespace Column**: Namespace column is automatically hidden when a namespace filter is active to reduce redundancy.
- **Percentile Help**: Added tooltip on the Server tab explaining how histogram bucket boundaries affect P95/P99 accuracy, with link to configuration docs.

### Bug Fixes

- **Error Rate Calculation**: 5 call sites used raw division instead of `calculateErrorRate()`, risking NaN/Inf display. All now use the canonical helper with validation and clamping.
- **Input Sanitization**: Defense-in-depth `MustSanitizeLabel()` applied to environment parameter in frontend metrics handler.
- **Client-side Filtering**: Fixed filtering on Dependencies and ServiceInventory pages not responding to user input.
- **Dependency Detail**: Fixed external services missing data — address normalization, deduplication, and P95 calculation for external dependencies.
- **Trace Search**: Search `http.route` in addition to span name for trace lookups, improving hit rate.
- **Error Sparklines**: Error sparkline column now renders actual time-series charts instead of static bars.
- **Pod Count**: Runtime pod count deduplicates by instance/pod, fixing inflated container counts on the Server tab.
- **Duplicate Rows**: Fixed service list showing duplicate rows from inconsistent metric labels.
- **URL Sanitization**: Fixed corrupted environment params from browser history on all pages.
- **Navigation & Auth**: Fixed critical bugs in navigation, auth header forwarding, and regex patterns.
- **External Dependencies**: Include external domains in global dependencies list.

### Refactoring

- Consolidated duplicate model types across packages and reduced verbose code patterns.
- Added critical tests for API contract, metric math, and model serialization.

### Documentation

- Comprehensive metrics pipeline and operator configuration guide.
- Documented all metrics, traces, and log data with origins.

### CI

- Fix release workflow to publish instead of leaving as draft.
- E2E workflow only starts Grafana, not full LGTM stack.
- Heatmap height and topology layout improvements.

## 0.2.1 (2026-04-22)

### Features

- **Auth**: Auto-managed service account via Grafana's `externalServiceAccounts` feature (Grafana 10.3+). When enabled, the plugin authenticates automatically with zero configuration — no manual token needed.
- **Auth**: 3-tier auth fallback: auto-managed token → manual service account token → forwarded user headers
- **Auth**: Added IAM permissions (`datasources:query`) to `plugin.json` for zero-config auth
- **Config Page**: Updated authentication section to document both auto-managed and manual token options
- **Environment**: Dependencies page now respects the selected environment filter — spanmetrics queries filter by `k8s_cluster_name` for accurate per-environment dependency data
- **Environment**: Added environment dropdown to the global Dependencies page
- **Environment**: Environment selection is preserved through dependency navigation (list → detail → upstream services → back)
- **Environment**: Faro frontend detection now uses environment-specific Loki when an environment filter is active
- **Environment**: Info banner on Traces/Logs tabs when no environment is selected and per-environment datasources are configured

### Utilities

- **Datasources**: New `useConfiguredEnvironments()` and `useHasEnvironmentOverrides()` hooks for reading plugin environment config

## 0.2.0 (2026-04-21)

### Features

- **Auth**: Service account token support for deployments behind OAuth2 proxies (Wonderwall/Nais). The plugin backend now authenticates internal datasource proxy calls using a Grafana service account token stored in `secureJsonData`, fixing 401 errors when Grafana runs behind an OAuth2 sidecar.
- **Config Page**: Prerequisites alert with links to OTel Collector spanmetrics and servicegraph connector documentation
- **Config Page**: Detailed descriptions for all configuration sections — datasource purposes, environment overrides, authentication, and auto-detection behavior
- **Config Page**: Warning alert when auto-detect finds no span metrics, with troubleshooting guidance
- **Config Page**: Detection results now show Tempo, Loki, and service graph connectivity status

### Bug Fixes

- **Auth**: Centralized `applyAuth()` on PrometheusClient ensures consistent auth across all internal API calls (queries, label lookups, health checks)
- **Auth**: Preserve `X-Grafana-Org-Id` header when using service account token to maintain correct org context

### CI

- Remove invalid `publish: true` input from release workflow
- Update e2e action versions (e2e-version v1.2.1, wait-for-grafana v1.0.2, upload-report-artifacts v1.0.1)
- Remove deprecated `config.apps` usage from datasource config resolution
- Fix golangci-lint revive false positive for standard `plugin` package name

## 0.1.2 (2026-04-21)

### Bug Fixes

- **Endpoint Table**: Fix truncated endpoint names showing identical text via colgroup column widths and 2-line clamp
- **Heatmap**: Duration distribution now syncs with page time picker by merging into shared EmbeddedScene
- **Heatmap**: Add minInterval to prevent sparse data in short time windows
- **Dependencies**: Dependency detail charts fall back to spanmetrics (`server_address`, `http_host`) when service graph metrics are unavailable
- **Traces**: Traces tab now uses shared page time range instead of hardcoded 1-hour window
- **Dependencies**: Fix impact column bar+label alignment in dependencies tab
- **Backend**: Use localhost for internal API calls and propagate auth headers for production proxy

### Features

- **Service Inventory**: Add time range picker dropdown to toolbar
- **Config**: Datasource configuration uses dropdown selectors populated from Grafana API, with auto-detection of default/sole datasources and environment override patterns
- **Tooling**: Convert Makefile to mise task runner with hierarchical tasks (`frontend:*`, `backend:*`, `deploy:*`)
- **Tooling**: Add local deployment tasks (`deploy`, `deploy:up`, `deploy:down`, `deploy:restart`, `deploy:logs`, `deploy:status`, `deploy:demo`)
- **Tooling**: Pre-commit hook runs full check+test+build pipeline via `mise run all`

### CI

- Fix workflow file issue: use `env` context instead of `secrets` in step-level `if:` condition
- Add gitleaks secrets scan and plugin.json validation to mise check pipeline
- Backend tests now enforce Go coverage ≥ 10% threshold (matching CI)

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
