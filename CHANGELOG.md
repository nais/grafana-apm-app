# Changelog

## [0.25.0](https://github.com/nais/grafana-apm-app/compare/nais-apm-app-v0.24.0...nais-apm-app-v0.25.0) (2026-09-05)


### Features

* **alerts:** new issues → Slack via a copy-pasteable PrometheusRule ([#177](https://github.com/nais/grafana-apm-app/issues/177)) ([257c88c](https://github.com/nais/grafana-apm-app/commit/257c88cfaa7e34b8d447a0e99d9b1ed134544e02))
* **scorecard:** make every failing readiness check one click to fix ([#176](https://github.com/nais/grafana-apm-app/issues/176)) ([7abe3ad](https://github.com/nais/grafana-apm-app/commit/7abe3ad4db8cd0540f2f8cf97b0c09b6e0cad11d))


### Bug Fixes

* **build:** drop tsconfig baseUrl ahead of the TypeScript 7 bump ([#179](https://github.com/nais/grafana-apm-app/issues/179)) ([a6399fc](https://github.com/nais/grafana-apm-app/commit/a6399fc045519cb992cd6ceb751c01c5c8ebffc5))
* **deps:** pin transitive dependencies flagged by Dependabot ([#178](https://github.com/nais/grafana-apm-app/issues/178)) ([8cfbc1f](https://github.com/nais/grafana-apm-app/commit/8cfbc1f34881815ca30423c831160215c58639aa))

## [0.24.0](https://github.com/nais/grafana-apm-app/compare/nais-apm-app-v0.23.1...nais-apm-app-v0.24.0) (2026-09-05)


### Features

* **naissync:** prune stale deploy annotations ([#173](https://github.com/nais/grafana-apm-app/issues/173)) ([dba7c66](https://github.com/nais/grafana-apm-app/commit/dba7c66c526daed24e5d4ea2697eb1c0890a5e47)), closes [#128](https://github.com/nais/grafana-apm-app/issues/128)


### Bug Fixes

* **issues:** collapse stdout copy of an OTLP-exported exception ([#171](https://github.com/nais/grafana-apm-app/issues/171)) ([1c3bab0](https://github.com/nais/grafana-apm-app/commit/1c3bab0068b39ed8056368def5619ad93ca876eb))

## [0.23.1](https://github.com/nais/grafana-apm-app/compare/nais-apm-app-v0.23.0...nais-apm-app-v0.23.1) (2026-09-05)


### Bug Fixes

* **issues:** anchor the server-occurrence scan so drawer details match the list ([#157](https://github.com/nais/grafana-apm-app/issues/157)) ([0bade9b](https://github.com/nais/grafana-apm-app/commit/0bade9b7cd886489955439a32f8c820a080a0b99))
* **test:** dedupe react-router so grafana-ui links see the test Router ([#169](https://github.com/nais/grafana-apm-app/issues/169)) ([6c8eb0f](https://github.com/nais/grafana-apm-app/commit/6c8eb0fc9512d91aee07973d6be5ade294301a81))

## [0.23.0](https://github.com/nais/grafana-apm-app/compare/nais-apm-app-v0.22.1...nais-apm-app-v0.23.0) (2026-08-03)


### Features

* **seed:** deterministic synthetic Faro telemetry generator ([#135](https://github.com/nais/grafana-apm-app/issues/135)) ([dcf3c97](https://github.com/nais/grafana-apm-app/commit/dcf3c97c6472ccc62db13929b4395bdae5a98961))


### Bug Fixes

* **build:** migrate TypeScript config for version 7 ([#155](https://github.com/nais/grafana-apm-app/issues/155)) ([fa27c8d](https://github.com/nais/grafana-apm-app/commit/fa27c8dfdd98695571f966f99186f81e7b1304ff))
* **grafana:** support Grafana 13 local development ([#152](https://github.com/nais/grafana-apm-app/issues/152)) ([dbd7dc3](https://github.com/nais/grafana-apm-app/commit/dbd7dc32df12074d9f1e5f485c544fbfaaac3a93))
* **scorecard:** mark browser telemetry not-applicable for pure backends ([#142](https://github.com/nais/grafana-apm-app/issues/142)) ([60db992](https://github.com/nais/grafana-apm-app/commit/60db992580c621ce1a3160f743e9c08efdf338c5))

## [0.22.1](https://github.com/nais/grafana-apm-app/compare/nais-apm-app-v0.22.0...nais-apm-app-v0.22.1) (2026-07-07)


### Documentation

* **adr:** backend stack traces via OpenTelemetry, not log-pipeline merging ([#129](https://github.com/nais/grafana-apm-app/issues/129)) ([e1c20dd](https://github.com/nais/grafana-apm-app/commit/e1c20ddc1bd0c80272f66005caee883a2deb980f))

## [0.22.0](https://github.com/nais/grafana-apm-app/compare/nais-apm-app-v0.21.0...nais-apm-app-v0.22.0) (2026-07-06)


### Features

* **database:** Phase 2 — Top queries (normalized, Tempo-sourced) ([#119](https://github.com/nais/grafana-apm-app/issues/119)) ([#124](https://github.com/nais/grafana-apm-app/issues/124)) ([a6c427d](https://github.com/nais/grafana-apm-app/commit/a6c427d2d10e53802ab99fef75da5688d4b248d5))
* **issues:** richer context for backend log occurrences ([#118](https://github.com/nais/grafana-apm-app/issues/118)) ([b77673b](https://github.com/nais/grafana-apm-app/commit/b77673bf6c8c4e0438fc7fd81b13e731ac0f100d))

## [0.21.0](https://github.com/nais/grafana-apm-app/compare/nais-apm-app-v0.20.2...nais-apm-app-v0.21.0) (2026-07-05)


### Features

* **alerting:** harden defaults= contract ([#77](https://github.com/nais/grafana-apm-app/issues/77)) + surface firing state ([#33](https://github.com/nais/grafana-apm-app/issues/33) Phase 1) ([#104](https://github.com/nais/grafana-apm-app/issues/104)) ([85b6a88](https://github.com/nais/grafana-apm-app/commit/85b6a88589913a8e617f12c051c9a8bd1b0db95d))
* **alerts:** read-only firing-alert detail drawer ([#32](https://github.com/nais/grafana-apm-app/issues/32)) ([#110](https://github.com/nais/grafana-apm-app/issues/110)) ([2996d1e](https://github.com/nais/grafana-apm-app/commit/2996d1eaaa734606a1ad6544d1840aa047d7588c))
* **frontend:** detect minified stacks + source-map doctor ([#60](https://github.com/nais/grafana-apm-app/issues/60)) ([#103](https://github.com/nais/grafana-apm-app/issues/103)) ([c402ffa](https://github.com/nais/grafana-apm-app/commit/c402ffa248f496f1a4cbcde688352cc14c2f95cc))
* **issues:** server-issue drawer parity — open the exception drawer for backend errors ([#84](https://github.com/nais/grafana-apm-app/issues/84) Phase 1) ([#93](https://github.com/nais/grafana-apm-app/issues/93)) ([458950a](https://github.com/nais/grafana-apm-app/commit/458950a34d0d3e5512781fb17359ef3d244eb0f2))


### Bug Fixes

* **queries:** close CodeQL request-forgery finding in GetAlertRules ([#102](https://github.com/nais/grafana-apm-app/issues/102)) ([20227bd](https://github.com/nais/grafana-apm-app/commit/20227bd86f147fe0c6290e69e986f027743d67af))

## [0.20.2](https://github.com/nais/grafana-apm-app/compare/nais-apm-app-v0.20.1...nais-apm-app-v0.20.2) (2026-07-05)


### Bug Fixes

* **config:** allow clearing the service account token + de-bloat the page ([#92](https://github.com/nais/grafana-apm-app/issues/92)) ([b6afbc2](https://github.com/nais/grafana-apm-app/commit/b6afbc2fd57a5cde9824a3a96b1e36e4e631aba1))

## 0.20.1 — "Legend" patch (2026-07-05)

### Fixes

- **Triage state failed with 502 in production** — the plugin's `iam.permissions` (plugin.json) declared only `datasources:query`, so Grafana's auto-provisioned managed service account had no access to the annotations API that triage reads/writes. Added `annotations:read`/`create`/`write`. Also unblocks deploy-marker annotations, which use the same service account.
- **Logs tab failed to render on issue deep-links** — a search term containing a regex metacharacter (e.g. `[` from an Issues-table "view logs" link) was regex-escaped but not string-escaped, producing an invalid `\[` LogQL string escape that Loki rejected. `LogsTab` now applies `escapeQueryString` around the regex, matching the Traces tab.

## 0.20.0 — "Legend" (2026-07-05)

### Features

- **Fingerprint-grouped exceptions** — Top Exceptions now groups by a stable, versioned fingerprint computed in the backend (exception type + normalized message) instead of the raw per-message Alloy hash: one logical error is one row even when messages carry UUIDs, URLs, or timestamps, with a "merged ×N" badge showing how many raw hashes combined. The Exception Drawer opens via a shareable `issueId` and aggregates occurrences across all member hashes; legacy `exceptionHash` links keep working. (#62)
- **Frontend tab follows the page time range** — The Frontend tab's panels were pinned to a hardcoded last-1h window; they now honor the shared `from`/`to` URL range like every other tab.
- **Top Exceptions promoted to a full-width row** — The issues table now sits directly under the health stats with the full page width, each row showing a share-of-total bar; Exception Types moved down beside the browser panels. Long issue lists paginate 10 rows at a time, and the backend caps the payload at the top 100 groups.
- **Deploy markers on charts** — RED and Frontend panels render deployment annotations (org annotations tagged `nais-apm:deploy`) as markers with version and workflow link in the tooltip; a reusable GitHub Action for writing them ships under `infra/actions`. (#64)
- **One-click alert rules** — "Create alert" in the Exception Drawer and "Alert on error rate" in the service header open Grafana's alert editor pre-filled with the right query (detected metric names, fingerprint-scoped exception spikes with a deep link back to the drawer, web-vitals degradation). Rules belong to the team, not the plugin. (#65)
- **Grafana Drilldown integration** — "Open in Logs Drilldown" from the Logs tab, and an "Open in Nais APM" link on Grafana's Explore toolbar that recognizes `service_name` in the current query.
- **Versions panel** — per-release sessions, adoption share, error-free rate, and exception counts under Top Exceptions, enriched with deploy timestamps from deploy annotations ("did this start with today's release?"). (#64)
- **Web-vitals attribution** — three new panels show the slowest LCP elements, INP interaction targets, and CLS layout-shift sources from the attribution data Faro v2 already ships.
- **Readable stack traces for console-captured exceptions** — The Exception Drawer now collapses runs of Faro SDK, vendored-dependency, and browser-native frames behind an expandable toggle and highlights the first in-app frame as the likely error origin. Exceptions captured via `console.error` get an explanatory badge: their stack shows the console call site, not where the error was thrown. Works retroactively on existing Loki data. (#66)
- **Grafana-managed alerts on the namespace page** — Namespace alert surfacing now merges Grafana unified-alerting rules (with a "Grafana alert" badge) alongside Mimir ruler rules, fetched in parallel and deduplicated by name. (#65)
- **Fuzzy service search** — The service inventory search matches partial, misspelled, and out-of-order tokens (e.g. `paymnt svc` finds `nais-payment-service`), ranked by relevance with exact prefix matches first. (#61)

- **Issue triage** — resolve, ignore, reopen, and assign exceptions, shared across all users and Grafana replicas via an append-only event log in org annotations (zero new infrastructure; the log is the audit history). The Top Exceptions list gains an Unresolved/All/Resolved/Ignored filter (default hides handled issues), per-user "mute for me", and a Regressed badge that bubbles resolved-but-recurring issues to the top after a newer deploy. The drawer gets a triage bar with assignee. (#57)
- **Automatic deploy annotations** — configure `naisApiUrl` + `naisApiToken` and the backend mirrors successful nais deployments as deploy markers, idempotently — no per-team CI step needed. (#64)
- **Unified Issues: backend errors join the list** — the Top Exceptions panel now also groups exceptions from the service's own backend logs (OTLP structured-metadata and JSON logstash shapes) through the same fingerprint pipeline, with browser/server source badges, a source filter, pod-impact counts, pre-filtered Logs deep links, and example-trace links via event-scope TraceQL (Tempo ≥ 2.6). Triage works identically for server issues. (#63)
- **Session replay & crash snapshots (opt-in)** — apps using `@nais/apm` can enable error-triggered session replay (`sessionReplay`) or lightweight masked DOM snapshots on crash (`screenshotOnError`); both default off, masked at capture time with a non-overridable privacy floor. The Exception Drawer plays recordings (seeked to just before the error) or shows the snapshot via a lazy-loaded player that non-replay users never download. (#58, #67)
- **Sessions explorer** — search sessions by user or id, see per-session error counts and metadata, and jump straight into the session's logs. (roadmap M5)
- **"New exceptions" alert template** — a fourth one-click alert rule fires per exception hash first seen in the last 30 minutes (7-day lookback, honest about its approximations in the alert text). (#65)

- **Dedicated Issues tab** — the unified triage surface (browser and server exceptions, releases, sessions) is now its own top-level tab; the Frontend tab is reordered vitals-first so each surface has a single clear job. (#69)
- **Database tab** — per-service query analytics and connection-pool health derived from database span metrics, verified across MongoDB, Oracle, and PostgreSQL apps; the empty states double as interim instrumentation docs. (#14)
- **Service health header** — the Overview page leads with an at-a-glance health signal and baseline deltas versus the previous period (a pragmatic stand-in for anomaly detection), in deploy-marker context. (#35)
- **Log patterns** — the Logs tab gains a Patterns view that clusters high-volume log lines via Loki's pattern ingester, plus a "new error patterns" card, to show the shape of an incident faster than scrolling raw logs.
- **Trace analytics** — TraceQL-metrics breakdowns group latency and error rate by span attribute ("which tag explains the p99") on Tempo instances that expose the metrics API.
- **Faceted issue search** — narrow the Issues list by app version, browser, or page; facet values are discovered from the data and offered as dropdowns, with a triage-status filter alongside. (M6)
- **Global time picker** — a single page-header time picker drives every tab and fleet page through the shared `from`/`to` URL params, replacing the per-tab pickers.
- **User feedback** — apps using `@nais/apm`'s feedback API stream user feedback to Loki; matching entries are joined to issues by fingerprint and shown inline in the Exception Drawer.
- **Custom application metrics** — zero-config auto-discovery surfaces app-defined metrics and Faro custom measurements without denylist maintenance. (#68)
- **Auto-refresh on inventory pages** — the non-Scene pages (service inventory, jobs, service map) now refresh on an interval like the Scene-based tabs. (#30)
- **SLO error budgets** — multi-window burn-rate alert-rule templates plus an error-budget panel on the Overview tab, computed from RED metrics — a self-hosted answer to cloud-only SLO tooling.
- **Profiling tab** — a capability-gated Pyroscope tab with span-to-profile links, shown only when a Pyroscope datasource is detected. (M7)
- **Service scorecards** — an observability-readiness score per service, enriched with ownership, runbook, and repository links from the nais Console API. (#73)
- **Jobs monitoring** — a cron / Naisjob inventory built from kube-state-metrics: schedules, last and next run, failure streaks, and one-click logs. (#74)
- **Global service map** — the fleet-wide service map returns with namespace clustering, replacing the all-services graph removed in 0.5.0. (#22)
- **In-plugin documentation links** — contextual links to the user docs and the `@nais/apm` SDK throughout the UI.

### Fixes

- **Session counts zeroed out on wide time ranges** — the distinct-sessions query exceeds Loki's series limit for chatty apps; it now retries over a narrowing recent window (labeled in the column header, e.g. "Sessions (last 5m)") and shows a dash instead of a misleading 0 when even that fails. Exception queries now use Grafana's `/api/ds/query` API instead of the deprecated datasource proxy.
- **Column sorting was dead while searching** — fuzzy-search relevance ranking silently overrode explicit column sorts; relevance is now only the default order during a search.

- **Infrequent dependencies missing from the service map** — The service-graph rate window now spans the full selected time range (floor 5m, cap 24h) instead of capping at 1h, so hourly batch jobs and cron-driven dependencies stay visible on wide dashboard ranges. (#36)
- **Status boards re-queried a frozen time window** — Auto-refresh on the Ops Status Board and namespace Status Board now re-resolves relative time ranges (`now-1h`) each tick instead of re-querying the window resolved at first page render forever.

- **Server issues matched real backend log shapes** — the unified Issues server side now recognizes the OTLP/semconv, JSON-body (logback/logstash, pino, slog), and unstructured plain-text log shapes seen in production, so backend exceptions actually appear instead of being silently missed; error-level lines with no titleable content surface as a single "Unparsed error logs" group rather than vanishing. (#63)
- **Connection-pool runtime metrics** — pool utilization now keys on the OTel `pool_name` label, fixing missing or merged pool rows on the Runtime tab.
- **Duplicated error panels removed** — the Overview and Frontend tabs no longer render the same error panel twice (IA review P4/P5).
- **Logs tab severity filter dropped plain-text logs** — filtering now matches Loki's `detected_level` structured metadata instead of parsing the log body as JSON, so non-JSON (plain-text, logfmt) logs are no longer silently excluded from the severity filter and volume panel.
- **Web Vitals enrichment now reports p75** (per the Core Web Vitals definition and matching the histogram panels) instead of the mean.

### Performance

- **Request coalescing and wider caching** — Concurrent cache misses for the same key (wallboards polling in lockstep) now share a single backend query fan-out; all read endpoints (health, operations, endpoints, runtime, dependencies, connected, graphql) are cached; capability probes are coalesced so cache expiry can't stampede detection queries; `/services` sparkline resolution is clamped server-side to ≤50 points per series and the inventory fetches sparklines for the visible page only; namespace service-graph queries are scoped to the namespace's services instead of fetching all fleet edges; label-values lookups are bounded to the request time range; the Exception Drawer's Loki queries use line prefilters and explicit time bounds. (#69)
- **Fewer redundant fetches** — Dependency detail no longer fetches fleet-wide sparkline series for its namespace lookup, and label-override settings no longer produce a fresh object per render (which cascaded into scene rebuilds and drawer refetch loops).

### Documentation

- **Development roadmap** — the milestone/track sequencing across the plugin, `@nais/apm` SDK, and platform tracks now lives in GitHub Milestones and roadmap tracking issue #91.
- **Stable URL contract** — `docs/url-contract.md` freezes the Exception Drawer deep-link parameters as a stable API for alert annotations and shared links, and now also documents the Issues/Database/Profiling tabs, the Jobs and Service Map fleet routes, the issue facet params, and the global header time range.
- **Resource API reference** — a documented, versioned resource API with a drift-proof OpenAPI spec. (#75)

## 0.13.4 (2026-07-01)

### Fixes

- **Exception Drawer Close Loop** — Solved a React state update race condition where closing the Exception Drawer would update parameters sequentially. Both the `exceptionHash` and `exceptionSessionId` query parameters are now deleted atomically in a single `setSearchParams` transaction, guaranteeing that the drawer closes immediately.

## 0.13.3 (2026-07-01)

### Fixes

- **Exception Drawer Close Loop** — Fixed an issue where closing the Exception Drawer caused it to instantly reopen. This was resolved by using React state refs inside the main occurrences loader to prevent changes to the active session ID query parameter from triggering full re-query loops.
- **Stable Session Sharing** — Added sync for `?exceptionSessionId` to the browser URL so that selected session timelines inside the drawer are fully stable and shareable.

## 0.13.2 (2026-07-01)

### Fixes

- **Production Plugin Config Crash** — Disabled Webpack code-splitting (chunk limit = 1) to bundle all pages and config components directly into `module.js`. This completely eliminates `ChunkLoadError` issues caused by missing or deleted chunk files (like `732.js`) in production deployments.

## 0.13.1 (2026-07-01)

### Fixes

- **Statically Linked Backend Binaries** — Statically compiled all Linux backend binaries with `CGO_ENABLED=0` to prevent execution failures (like `no such file or directory` or missing dynamic linker) inside minimal Alpine/Debian-slim Docker containers.
- **Dependency Security Fixes** — Upgraded `react-router-dom` to `6.30.4` to remediate the open redirect vulnerability (CVE-2026-40181).

## 0.13.0 (2026-07-01)

### Features

- **Session context switcher** — The Exception Drawer now allows developers to select different sessions (or occurrences) for the same exception hash directly from a Combobox dropdown. This dynamically updates both the metadata and the Session Timeline (breadcrumbs) in-place without losing context.
- **Custom event attribute rendering** — The Session Timeline now parses, extracts, and renders custom event attributes (e.g. from `faro.api.pushEvent`) formatted inline. Events with different attributes are no longer collapsed/deduplicated together to allow tracing distinct event progressions.

### Fixes

- **Console errors panel visibility** — Solved a gap where some console errors logged via Faro's console integration (captured as `kind="exception"` without a stack trace/hash) did not show up in the Top Exceptions table or the Console Errors panel. The panel query was expanded to match both `kind="log"` and `kind="exception"` console errors.
- **Duplicate event grouping** — Timeline breadcrumbs now group consecutive identical events in a row (e.g. repeated resource loads or console errors) and show a count badge (e.g. `(5x)`) to keep the history compact.

## 0.12.3 (2026-06-30)

### Features

- **Watchlist PromQL Performance Optimization** — Constrained queries for the Ops Status Board to only fetch services configured on the watchlist (including rate, error, latency, sparklines, and delta comparisons), preventing expensive cluster-wide Prometheus range queries.
- **UI Render Virtualization** — Limited the Ops Status Board service picker modal list to the top 100 entries to prevent browser stutter and rendering lag on large clusters.

### Fixes

- **React Key Collisions** — Switched service picker list elements to use unique compound keys (`${namespace}/${name}/${environment}`) to solve duplicate key warnings when services exist in multiple environments.
- **Misleading Empty State** — Hidden the "No services configured" empty state illustration if settings or watchlist loading fails with an error.
- **Attention Badge Accuracy** — Decoupled the attention badge calculation from the environment-filtered cards, ensuring critical issues are globally visible regardless of environment filters.
- **AppConfig Robustness** — Ensured `opsWatchlist` defaults to an empty array even if stored settings value is `null` or a non-array value.

## 0.12.2 (2026-06-04)

### Features

- **Inline ops service picker** — Ops Status Board can now add or remove monitored services directly from the dashboard with a Grafana modal, instead of forcing users into plugin configuration.

### Fixes

- **Watchlist diagnostics** — Ops watchlist fetch/save errors now surface a sanitized, contextual error message instead of a generic failure.
- **ServiceInventory test stability** — Reduced unnecessary async wrapping in the favorites toggle test to avoid flaky timing behavior in the full suite.

## 0.12.1 (2026-05-30)

### Fixes

- **Dependency vulnerabilities** — Patched js-cookie (CVE-2026-46625, HIGH), ws (memory disclosure), and qs (DoS) via pnpm overrides. Fixes Grafana plugin validator failure on release.

## 0.12.0 (2026-05-27)

### Features

- **Ops Status Board** — New cross-namespace monitoring page with curated watchlist, auto-rotating grid layout, and at-a-glance health indicators (error rate, latency P95, request rate). Designed for wall-mounted displays in team areas.
- **Shared ops watchlist** — Globally editable watchlist stored in plugin settings via a backend API endpoint. Any authenticated user can add/remove services without admin access. Backend uses service account token to update plugin jsonData on the user's behalf.
- **Centralized Loki support** — Cluster-scoped log queries for environments using a single centralized Loki instance instead of per-namespace datasources.

### Fixes

- **Watchlist security** — Preserve `secureJsonFields` when saving plugin settings to prevent wiping the service account token.
- **Watchlist concurrency** — Mutex-protected read-modify-write cycle prevents concurrent API calls from overwriting each other.
- **React concurrent mode safety** — Network calls moved out of state updater functions to avoid duplicate side effects.

## 0.11.0 (2026-05-19)

### Features

- **Ingress alias support** — Configurable hostname→service mapping makes on-prem (FSS) callers visible when they reach GCP services via nais ingress. For example, mapping `tilgangsmaskin.intern.nav.no → populasjonstilgangskontroll` reveals callers like oppgave and saf that were previously hidden. Backend expands caller queries with additional PromQL `or` clauses for each alias, and resolves aliased hostnames in the service map topology. Frontend adds a key-value editor in plugin settings for managing aliases.

## 0.10.1 (2026-05-07)

### Features

- **Label overrides for non-standard OTel pipelines** — Supports custom Prometheus label names (`serviceNameLabel`, `serviceNamespaceLabel`, `deploymentEnvLabel`) via plugin JSON config. Enables pipelines like Tempo's metrics generator (which emits `service` instead of `service_name`) to work without infrastructure-side relabeling. Both backend queries and frontend PromQL/LogQL are override-aware. Invalid label names are validated with regex and silently dropped. (PR #42, contributed by @m4r1u2)

### Fixes

- **CI fork PR permissions** — Fixed false-positive CI failures on pull requests from forks where the restricted `GITHUB_TOKEN` couldn't post PR comments.
- **Levitate compatibility check** — Changed to advisory mode to avoid blocking PRs on Grafana API type changes that don't affect runtime behavior.

## 0.10.0 (2026-05-06)

### Features

- **Health attention alerts** — Service overview shows an "Attention needed" section when operations or dependencies are degraded. Uses anomaly detection comparing current metrics against a previous period baseline, with both delta-based (2× increase) and absolute (≥5% error rate) thresholds.
- **Causality analysis** — When both operations and dependencies are degraded, the health alert indicates whether errors are likely cascading from downstream dependencies or appear internal. Uses volumetric comparison of dependency error volume against service error volume.
- **Per-page performance route grouping** — The Faro "Per-Page Performance" table now prefers `page_id` (from SDK's `generatePageId`) over raw `page_url` for grouping. Dynamic URL segments (e.g. `/sak/{id}/...`) are automatically normalized when the SDK provides route-level page IDs. Falls back to raw URL when `page_id` is absent. (Closes #41)

## 0.9.1 (2026-04-30)

### Fixes

- **Plugin metadata validation** — Fixed `extensions` field in plugin.json to use the object format (`addedLinks`) expected by Grafana's plugin validator, instead of the array format.

## 0.9.0 (2026-04-30)

### Features

- **Multi-hop service topology** — Explore service connections up to 3 hops deep with a depth control slider. BFS traversal from the focus service discovers transitive callers and dependencies.
- **Per-hop overflow collapsing** — Each hop level independently caps visible nodes (8 at hop 1, 6 at hop 2+), sorted by request rate. Overflow nodes are collapsed into "+N more" placeholders. Cascade hiding removes orphaned deeper nodes.
- **Hub detection and rate-weighted pruning** — Shared infrastructure nodes (e.g., Istio, Wonderwall) with 50+ connections are detected as hubs and displayed with a dashed purple border instead of expanding the full graph. Low-rate edges below 1% of parent rate are pruned to reduce noise.
- **Clickable graph nodes** — Clicking a node in the service topology graph navigates to its detail page. Service nodes go to the service overview; database, messaging, and external nodes go to the dependency page.
- **Node color coding by caller count** — Private dependencies (called by exactly one service) get a lighter blue icon badge, visually distinguishing them from shared services.
- **Fullscreen topology** — Toggle button expands the service topology graph to fill the viewport (Esc to exit).
- **Copy as Mermaid** — Export the current topology graph as a Mermaid diagram to clipboard.

### Fixes

- **Hex-suffixed service name normalization** — Preview/canary deployment names like `nav-dekoratoren-28e8c72f0abdc4109d600c` are normalized to their base name, preventing false self-loop edges.
- **BFS pruning correctness** — Fixed zero-rate pruning bypass, O(E²) infra node detection (now O(1) via pre-computed set), and non-deterministic candidate rate selection (now uses max rate across all edges).
- **Direction-aware BFS** — Callers expand leftward and targets expand rightward, producing a proper layered layout.
- **PromQL escaping** — Uses `promQLEscape` instead of `regexp.QuoteMeta` for correct PromQL regex patterns.
- **Dependency navigation from graph** — Clicking a database/messaging/external node now navigates to the dependency page instead of constructing a broken service URL.
- **ELK layout crash prevention** — Edges are included in the fallback layout pass to prevent crashes on degenerate graphs.

## 0.8.1 (2026-04-29)

### Features

- **Grouped Dependencies tab** — Dependencies are organized into sections (Attention, Databases & Messaging, Internal Services, External Services) with independent sorting per group.
- **Graph node overflow cap** — Service topology graph caps visible nodes at 8 per side, sorted by request rate, with a clickable "+N more" placeholder for overflow.
- **"View all in Dependencies tab" links** — Overview tab shows top-5 per dependency group with links that navigate to the full Dependencies tab.

### Fixes

- **K8s address classification** — Service names like `service.namespace` are now correctly classified as internal instead of external (TLD-aware hostname heuristic).
- **Topology edge completeness** — Outbound topology edges are always supplemented from span metrics, with a dynamic rate window matching the dashboard time range.
- **Favorites redirect preserves params** — Navigating to `/favorites` now preserves existing query params (env, sort, etc.) instead of dropping them.

## 0.8.0 (2026-04-29)

### Features

- **Favorite services ("My Apps")** — Star services to mark them as favorites; toggle the "My Apps" pill to filter the list to just your starred services.
- **Cross-device favorites sync** — Favorites are persisted to Grafana's per-user backend storage via `usePluginUserStorage`, so starred services follow you across browsers and devices. localStorage serves as an instant-render cache.
- **"My Apps" navigation entry** — Dedicated sidebar link that opens the service list pre-filtered to your favorites.
- **"Has errors" filter** — New pill toggle to show only services with active errors (errorRate > 0).
- **SDK/Language filter** — Multi-select dropdown to filter services by telemetry SDK language (Java, Node.js, Go, etc.).
- **URL state persistence** — All filter, sort, pagination, and favorite state is persisted to URL query parameters for shareable deep links.

### Improvements

- **Two-row toolbar layout** — Filters are split into semantic rows: Row 1 (scope) for data filters (search, namespace, environment, SDK, time range) and Row 2 (view options) for display toggles using Grafana-native FilterPill components.
- **PromValue type safety** — Replaced untyped `[2]interface{}` Prometheus value type with a proper struct and custom JSON marshaling, eliminating silent data corruption risks.
- **Shared plugin types** — Extracted `DsRef`, `EnvAwareDs`, `AppPluginSettings` into a shared `types/plugin.ts` module.
- **Context propagation** — Backend health checks now use `context.WithoutCancel` to preserve tracing spans.
- **useServiceData hook** — Extracted data-fetching hooks from ServiceOverview into a dedicated hook for testability.

## 0.7.3 (2026-04-28)

### Features

- **Pageloads & Sessions stats** — New stat panels showing total page loads (from FCP histogram) and unique sessions for the selected time range.

### Improvements

- **Accurate Pageloads count** — Uses FCP histogram bucket instead of generic measurements counter, giving a true per-page-load count.
- **Panel descriptions in plain language** — All tooltip descriptions rewritten to be understandable without prior CWV knowledge.
- **Grafana-native tooltips on bullet charts** — Help icons now use styled Grafana popovers instead of browser title attributes.
- **Per-Page Performance table** — Removed empty Measurements/TTFB columns; table auto-sizes to fill available width.
- **Top Exceptions table** — Error column auto-expands to fill table; count columns stay narrow.
- **Insights row layout** — CWV Rating, Pageloads, and Sessions panels equal width (15% each); Navigation Type gets remaining space.

## 0.7.2 (2026-04-28)

### Features

- **Pageloads & Sessions stats** — New stat panels in the Frontend tab showing total page loads (Mimir) and unique sessions (Loki) for the selected time range.

### Improvements

- **Responsive toolbar layout** — Filter inputs use flex-grow to fill available horizontal space (min 160px, max 320px) instead of fixed widths.
- **No layout shift on multi-select expand** — Toolbar uses absolute positioning so expanded pills overlap the table instead of pushing it down.
- **Top Exceptions table column widths** — Error column gets most of the horizontal space; count columns are narrow and right-aligned.

## 0.7.0 (2026-04-28)

### Breaking Changes

- **Mimir-first architecture** — Removed all Loki fallback logic. The Frontend tab now requires the Alloy Faro histogram pipeline in Mimir. Legacy gauge-based and raw-Loki-only pipelines are no longer supported.

### Features

- **CWV Rating panel** — Stat panels showing "% Good" for each Core Web Vital (LCP, FCP, CLS, INP, TTFB) computed from histogram bucket boundaries.
- **Browser Volume panel** — Pie chart showing measurement distribution by browser (Loki-based, visible when Loki data available).
- **Per-Page Performance table** — Top 20 pages ranked by traffic volume with color-coded vital thresholds.
- **Console Errors panel** — Shows top `console.error` messages when apps enable Faro `ConsoleInstrumentation`.
- **Traffic timeseries** — Combined page loads, error rate, and session starts over time.
- **Faro Kind filter in Logs tab** — When "Include browser telemetry" is on, filter by kind (Exceptions, Console Logs, Measurements, Events) using the indexed `kind` stream label.
- **Exception drill-down** — Clicking an exception navigates to the Logs tab pre-filtered to `kind=exception` with Faro telemetry enabled and the correct environment datasource.

### Improvements

- **Simplified capabilities model** — Reduced to `{ available, hasLoki, vitals, errorRate }`, removing multi-source adapter abstraction.
- **1-hour default time range** — Frontend tab defaults to `now-1h` instead of inheriting global range (prevents Loki timeouts).
- **Centralized metric definitions** — All Mimir counter/histogram names and Loki field names in `otelconfig.ts`.
- **Section builder architecture** — Six composable builders (`buildCwvRatingSection`, `buildHistogramSection`, `buildPerPageSection`, `buildErrorsSection`, `buildSupportSection`, `buildTrafficSection`).
- **Errors section layout** — Split cramped 4-panel row into two rows: Exceptions (types + messages) and Browsers (breakdown + volume).

### Bug Fixes

- **CWV Rating "Bar charts require a string field"** — Switched from barchart (needs string x-axis) to stat panels.
- **Browser Volume "Value #volume"** — Range queries resolve `legendFormat` templates; instant queries don't.
- **hasLoki detection** — Widened detection window from 1h to 6h to avoid false negatives on low-traffic apps.
- **Exception links** — Fixed navigation for empty namespaces (uses `_` placeholder), passes environment and Faro filters.

### Removed

- Legacy Alloy gauge pipeline support
- Loki-only fallback path (`adapter.ts`, multi-source resolution)
- `metricsSource` field from backend response

## 0.6.2 (2026-04-27)

### Bug Fixes

- **Multi-environment filtering in topology graph** — Backend now supports comma-separated environment values using PromQL regex matching (`=~"prod|prod-fss"`). The namespace page service map and dependencies correctly filter when multiple environments are selected.
- **E2E test reliability** — Replaced `networkidle` wait with `load` state in test fixtures to prevent timeouts from Grafana's persistent WebSocket connections.

## 0.6.1 (2026-04-27)

### Bug Fixes

- **Service topology graph respects environment filter** — The service map and namespace dependencies on the namespace page were ignoring the multi-select environment filter. Now correctly passes the selected environment to the backend when a single environment is chosen.

## 0.6.0 (2026-04-26)

### Features

- **Status Board** — New TV-friendly dashboard view showing all services in a namespace as color-coded health cards (green/yellow/red/gray). Auto-refreshes, tracks last-seen services, and auto-paginates through cards when they exceed the viewport. Accessible from the namespace page via "Status Board" button. (#29)
- **Card Size Selector** — Status Board supports S/M/L card sizes to fit more or fewer services on screen. Small cards show name + status only; large cards include sparkline trends.
- **Auto-Pagination** — Status Board automatically rotates through pages at a configurable interval (10s/30s/60s) when services exceed the viewport, perfect for wall-mounted displays.
- **Multi-Select Environment Filter** — All pages (Services, Namespace, Status Board) now support filtering by multiple environments simultaneously using a multi-select combobox.
- **Mise E2E Tasks** — Added `mise run e2e` and `mise run e2e:ui` for running Playwright tests locally with a health check gate.

### Improvements

- **Explicit Route Redirect** — Plugin root URL now properly redirects to `/services` instead of rendering the page at the root path.
- **Sandbox-Resilient Build** — `mise run all` now works in sandboxed environments (macOS sandbox, CI) by auto-detecting inaccessible parent configs and gracefully falling back for coverage/mage tools.
- **Quieter Build Output** — `mise run all` shows brief `✓ passed` on success and full output only on failure.

### Bug Fixes

- **Grid Layout** — Fixed Status Board showing 1 card per row when data loaded asynchronously (ResizeObserver now attached via callback ref outside conditional rendering).
- **Filter Trap** — Fixed issue where hiding the environment filter when only one environment existed could trap users with an active but invisible filter.
- **E2E Test Stability** — Tests now use Playwright `.or()` locator chains to handle Grafana nav rendering differences across versions 12–13.

## 0.5.4 (2026-04-26)

### Features

- **Namespace Alert Rules** — Namespace page now shows Prometheus alerting rules for the team, fetched from the Mimir ruler API. Displays firing, pending, and inactive rules with severity badges, instance counts, and relative timestamps. Source is labeled "Prometheus Alerts" so teams know where rules come from.
- **Cross-Cluster Alert Deduplication** — Same alert rule defined in multiple clusters (e.g., `dev` and `dev-fss`) is automatically merged into a single entry with combined instance counts and the earliest active timestamp.

### Improvements

- **Alerts 2-Column Layout** — Alert cards use a responsive two-column grid with subtle state-colored backgrounds instead of heavy bordered boxes.
- **Stat Panels De-Boxed** — Namespace stats (Services, Rate, Errors, Healthy) now render without borders for a cleaner look.
- **Inactive Rules Collapsed** — Inactive alert rules are collapsed by default with an expandable toggle to reduce noise.

### Bug Fixes

- **Mimir Compatibility** — Removed `type=alerting` query parameter from ruler API call (unsupported by some Mimir versions); filter alerting rules client-side instead.
- **Ruler File Path Extraction** — Fixed namespace extraction from NAIS ruler file paths (`{cluster}/{namespace}/{name}/{uuid}` format — was incorrectly extracting the cluster segment).
- **Unknown Alert States** — Unknown/unexpected alert states now sort to the bottom instead of being treated as highest priority (firing).
- **Invalid Date Handling** — Invalid or future `activeSince` timestamps now display the raw ISO string instead of "NaNd ago".
- **Description Merge** — Alert description field is now properly merged during cross-cluster deduplication.

## 0.5.3 (2026-04-25)

### Features

- **Dependencies Tab with Callers & Dependencies** — Dependencies tab now shows both Callers (upstream services) and Dependencies (downstream databases/APIs/services) in two sortable sections with independent sort state.
- **Dependencies Panel on Overview** — Compact dependencies table on the service Overview tab showing outbound dependencies alongside the Callers table.
- **Clickable Operations → Traces** — Operation rows on the Overview tab are now clickable, navigating directly to the Traces tab pre-filtered by span name and span kind.
- **Outbound Calls Section** — Operations tab (formerly "Server") now includes an "Outbound Calls (Client)" section showing HTTP client endpoints (excluding database spans which have their own section).
- **Spanmetrics Topology Fallback** — Service topology graph now falls back to spanmetrics-based edges when service graph metrics are unavailable, ensuring graphs render in all environments.
- **Namespace Health Indicators** — Enhanced namespace page with health status indicators and a "Needs Attention" section highlighting services with elevated errors or latency.

### Improvements

- **"Server" → "Operations" Tab Rename** — Renamed the Server tab to Operations to better reflect its expanded scope (inbound + outbound endpoints).
- **"Connected Services" → "Callers" Naming** — Unified terminology across the app: upstream services are "Callers", downstream services are "Dependencies".
- **Tempo Availability Gating** — "View traces" actions on the Overview tab are only shown when Tempo is available, preventing dead-end clicks.
- **UI Polish** — Replaced emoji indicators with themed components, tightened layout spacing, improved namespace table and NeedsAttention card styling.
- **Documentation** — Added design philosophy and visualization guide docs; updated all references for the Operations/Callers rename.

### Bug Fixes

- **Topology Graph for prod-fss Services** — Fixed topology graph not rendering for services in `prod-fss` and other environments without service graph metrics.
- **Service Graph Scoping** — Scoped service graph queries by service for per-service topology; skip namespace filter for per-service views.
- **Environment Edge Filtering** — Service graph edges now properly filter by environment.
- **Dependency Error Rate Display** — Fixed dependency error rate showing as 10000% instead of 100%.
- **RED Panel No Data** — Prevented RED panels from showing "No Data" during capability loading phase.

## 0.5.2 (2026-04-23)

### Features

- **Bullet Graph Visualizations** — New compact bullet graph cards for all five Core Web Vitals (LCP, FCP, CLS, INP, TTFB) with qualitative color bands and threshold markers. Works for both Mimir and Loki data sources.
- **Loki Vital Value Extraction** — Backend now queries Loki for individual vital values using weighted mean aggregation, enabling bullet graphs for Faro-in-Loki services.
- **Environment Dropdown in Config** — Plugin config page auto-detects available environments from Mimir data and presents them as a dropdown instead of a free-text input.
- **Browser Filter Dropdown** — Frontend tab includes a Browser variable selector (Chrome, Firefox, Safari, Edge, Opera, Samsung Internet) for filtering Web Vitals by browser.
- **Logs Tab Enhancements** — Pod filter, severity stream labels, and Faro log toggle added to the Logs tab.

### Bug Fixes

- **Environment Datasource Routing** — `MimirWebVitalsPanels` now receives the `environment` prop so it queries the correct Loki/Tempo datasources instead of always falling back to the default.
- **Provisioning Config Keys** — Updated provisioning file from `dev-gcp`/`prod-gcp` to match actual `k8s_cluster_name` values (`dev`, `dev-fss`, `prod`, `prod-fss`), preventing config reset on every deploy.
- **Weighted Mean for Loki Vitals** — Changed Loki vital queries from `avg(avg_over_time)` to `sum(sum_over_time) / sum(count_over_time)` for proper weighted aggregation matching Scene panel values.
- **Bullet Graph Layout Shift** — Rating text ("Needs improvement") now renders on its own line to prevent inconsistent card heights.
- **Controls Above Bullet Charts** — Bullet graphs are now embedded inside the EmbeddedScene so Browser/time controls render above them.
- **Topology Graph with Environment Filter** — Service topology graph now renders correctly regardless of environment filter selection.
- **Logs Severity Filter** — Moved severity filter from Loki stream selector to label filter pipeline and expanded matching to handle all `detected_level` case variants (e.g. `Error`, `ERROR`, `error`).

### Improvements

- **Frontend Tab Layout** — Improved table readability and dashboard layout for the Frontend tab.

## 0.5.1 (2026-04-23)

### Bug Fixes

- **E2E: Remove Stale Service Map Test** — Remove `service map page should render` e2e test that referenced the deleted `ROUTES.ServiceMap` constant (page removed in v0.5.0).
- **README: Absolute Links** — Convert all relative links in README.md to absolute GitHub URLs to satisfy the Grafana plugin validator for marketplace publishing.

## 0.5.0 (2026-04-23)

### Features

- **Namespace Overview Page** — New team/namespace page (`/namespaces/{ns}`) with aggregate stats tiles, service topology graph, services table with search/pagination, and external dependencies table with pagination. Navigate from any namespace link in ServiceInventory.
- **Server-Side Namespace Filtering** — Backend `/service-map` and new `/namespace-dependencies` endpoints filter by namespace using a service→namespace mapping from spanmetrics. Eliminates client-side filtering inaccuracies.
- **Service Topology for Large Teams** — Removed the 20-service cap on namespace topology graphs. ELK layout handles up to 300 nodes with zoom/pan controls.
- **Dependency Enrichment** — Database and messaging dependencies display enriched names like `postgresql (10.0.0.1)` or `kafka (brokers.example.com)` using `db_system` and `messaging_system` labels from Tempo's service graph metrics. No cross-fetching from spanmetrics needed.
- **Mermaid Export** — Copy button on the namespace topology graph exports the service graph as a Mermaid flowchart. Node shapes match types: cylinders for databases, hexagons for messaging, stadiums for external services.
- **Frontend Tab: Per-Page Performance** — New table grouping all five Core Web Vitals (LCP, FCP, CLS, INP, TTFB) by page URL with threshold-colored cells and measurement counts.
- **Frontend Tab: Console Errors** — New panel showing most frequent `console.error` messages from Faro logs, replacing the noisy Top Events panel.
- **Frontend Tab: Enhanced Exceptions** — Top Exceptions expanded to top 20 with full error messages, "Sessions Affected" column, and click-through Explore links to Loki.
- **Frontend Tab: Threshold Bands** — Green/yellow/red Web Vitals reference zones on INP and CLS time series panels (both Loki and Mimir paths).

### Improvements

- **Consistent Back Button** — Shared `BackButton` component across ServiceOverview, DependencyDetail, and NamespaceOverview pages.
- **Messaging System Classification** — `classifyDependency` now correctly distinguishes between Kafka, RabbitMQ, JMS, and generic messaging types, matching frontend icon rendering.
- **Shared Components** — Extracted `PageHeader`, `DataState`, section styles, and option helpers into reusable modules.
- **Environment Column** — Namespace services table shows environment column when multiple environments exist (hidden when env filter is active).
- **Framework Badge Styling** — Lighter weight (`font-weight: 400`) and subtle rounding (`border-radius: 4px`) for framework badges. Unknown frameworks now render a gray fallback badge instead of being hidden.
- **Canvas Layout** — Namespace page uses `PageLayoutType.Canvas` for a clean, headerless layout matching the service detail page.

### Bug Fixes

- **Service Node Misclassification** — Fix services receiving Kafka traffic being rendered as messaging infrastructure nodes. A node that also initiates calls is a service, not a broker.
- **Service Filter on Team Page** — Fix search filter not matching services and column alignment issues in the namespace services table.
- **Empty Service Topology** — Fix topology graph rendering as blank on namespace page. Root cause: ReactFlow `height: 100%` resolved to 0px when parent had no explicit height. Fixed by wrapping graph in container with explicit height.
- **Environment Dropdown Stuck** — Fix environment dropdown disappearing after selection. Now uses a separate unfiltered fetch for environment discovery, and always shows dropdown when a filter is active.
- **Sidecar Filtering** — Namespace page now hides known infrastructure sidecars (wonderwall, texas) consistent with ServiceInventory default behavior.
- **Empty Namespace Navigation** — Namespace links in ServiceInventory only render as clickable when namespace is non-empty, preventing broken route navigation.
- **Frontend Tab: Loki Aggregation** — Fix incorrect averages: `avg(avg_over_time(...))` computed average-per-stream then averaged those (wrong when streams have unequal sample counts). Now uses weighted mean via `sum(sum_over_time(...))/sum(count_over_time(...))`.
- **Frontend Tab: Rating Pie Chart** — Fix "Value #A" labels on the Web Vitals rating distribution pie chart. Now correctly shows "good", "needs-improvement", "poor".
- **Frontend Tab: Loki Query Parse Error** — Fix `count_over_time` failing with `unwrap` operator. The `unwrap` stage is now only applied to `sum_over_time`.
- **Frontend Tab: Explore Links** — Fix broken "Explore in Loki" links on exceptions table that produced duplicate `left=` URL parameters.

### Removed

- **Global Service Map** — Removed the global Service Map page which crashed browsers by loading all ~4000 services into a single graph. Per-service and per-namespace service maps remain functional. See [#22](https://github.com/nais/grafana-apm-app/issues/22) for the planned clustered replacement.

### Chores

- Add `.DS_Store` and `.vscode` to `.gitignore`.

## 0.4.4 (2026-04-22)

### Improvements

- **Backend Code Quality**: Extract shared request parsing (`reqparse.go`) and metric math helpers (`metricmath.go`), eliminating duplicated patterns across handlers.
- **Dependencies Module**: Split monolithic `dependencies.go` (1244 lines) into 5 focused files: handlers, classification, detail queries, connected services, and shared helpers.
- **Services Module**: Extract `aggregateServiceResults` from `fetchServiceSummaries`, splitting a 408-line function into two cohesive halves.
- **ServiceOverview Extraction**: Extract `buildServiceScene` (scene builder) and `OverviewTab` (operations, topology, connected services) — reduces ServiceOverview.tsx from 960 to 488 lines.
- **Parallel Query Pattern**: Convert manual WaitGroup/channel pattern in `queryConnectedServices` to use the existing `runInstantQueries` helper.

## 0.4.3 (2026-04-22)

### Features

- **Combobox Migration**: Migrate all 15 deprecated `Select` components to `Combobox`/`MultiCombobox` from `@grafana/ui` v12.4.2.
- **Release Script**: Add `mise run release` task for automated version bumping, CHANGELOG stamping, build verification, and git tagging.

### Bug Fixes

- **Exemplar Links**: Route trace exemplar links to the environment-resolved Tempo datasource instead of hardcoded dev Tempo.
- **Dependency Environment Filter**: Filter service graph dependencies by selected environment — prevents pre-prod dependencies from appearing when a prod environment is selected.
- **Kafka Consumer Dependencies**: Exclude Kafka consumer services (e.g., downstream subscribers) from the dependencies list — they are not dependencies of the producer and now only appear in Connected Services.
- **Connected Services Environment**: Pass environment filter to connected services queries so inbound/outbound services are scoped to the selected cluster.

## 0.4.2 (2026-04-22)

### Features

- **Panel Descriptions**: RED panels on ServiceOverview now include help text explaining what each panel measures (e.g., inbound SERVER requests vs all span kinds).

### Bug Fixes

- **Dependency Detail**: Fix dependency metrics showing zeros for addresses with standard ports (e.g., `idporten.no:443`) — queries now use regex matching to handle both normalized and raw address forms.
- **Service Detail Navigation**: Fix error when clicking connected services that have no namespace — the `_` wildcard placeholder was converted to empty string, producing double-slashes in API URLs that Grafana couldn't route to the plugin backend.
- **RED Panel Flashing**: Reduce unnecessary panel re-renders on ServiceOverview by stabilizing Scenes `useMemo` dependencies — destructure datasource/metric objects into primitive strings to prevent object identity changes from recreating the entire `EmbeddedScene`.

## 0.4.1 (2026-04-22)

### Features

- **Framework Detection**: Use `telemetry_sdk_language` from span metrics as fallback when framework-specific metric probing doesn't match. Adds Python, .NET, Java, and Go badges for services without framework-specific runtime metrics. Specific detection (Spring Boot, Ktor) still takes priority. Closes #20.

### Bug Fixes

- **Traces Tab**: Fix bad request when filtering by duration — move `duration >=`/`<=` inside the TraceQL span selector instead of using unsupported pipeline syntax.
- **Service Inventory**: Shrink Type column to fit badge width instead of fixed 120px. Remove Faro badge to prevent row wrapping.

## 0.4.0 (2026-04-22)

### Features

- **Dependency Detail**: Database dependencies now show target database and operation (`db_name · db_operation`) in a dedicated "Target" column in the operations table.
- **Dependency Detail**: Messaging dependencies now show topic names (`messaging.destination.name`) in a dedicated "Topic" column in the operations table.
- **Exemplars**: RED panels on ServiceOverview and DependencyDetail pages now display exemplar data points — click to jump directly to the originating trace.
- **Service Map**: Explicit handling of `virtual_node` connection type for external dependency classification.

### Bug Fixes

- **Service Inventory**: Services with only CLIENT, PRODUCER, or CONSUMER spans (Kafka consumers, batch jobs, event-driven workers) now appear in the inventory with full RED metrics and sparklines. Previously, only services with SERVER spans were discovered. Server-based services are unchanged — they continue using SERVER-only metrics for clean inbound request data.

## 0.3.1 (2026-04-22)

### Bug Fixes

- **Dependency Detail**: Fix query parse error for dependency names containing dots (e.g., `dmv18-scan.adeo.no`) — PromQL regex matchers now correctly double-escape special characters.

### CI

- Strip plugin signature in E2E tests so Grafana loads the plugin on localhost.
- Generate release notes from CHANGELOG.md instead of Grafana boilerplate.

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
