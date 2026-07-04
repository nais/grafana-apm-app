# Implementation plan: log patterns + trace analytics (M6)

Live-probed 2026-07-04 against production datasources; code not yet written
(session wrapped at the probe stage). Reuse these findings — do not re-derive.

## Probe findings (production facts)

**Log patterns — the Loki pattern ingester IS enabled in production:**
- `GET {grafana}/api/datasources/proxy/uid/nav-logs/loki/api/v1/patterns?query={service_name="X"}&start=<unix-s>&end=<unix-s>` → 200 with real clustered
  patterns (`<_>` placeholders), `level` field, `samples: [[unixSec, count]]`.
- The patterns endpoint accepts a bare stream selector ONLY — no `|=`/`| json`
  stages (400 otherwise). Error-only filtering must happen client-side on the
  returned `level`.
- `/api/ds/query` with `queryType: "patterns"` 500s on Grafana 12.4.0 — call
  the datasource proxy directly (pattern: `capabilities.go` checkHTTPHealth).
- High-volume test service: `tilbakekreving-backend` (259k error lines / 6h).

**Trace analytics — TraceQL metrics group-by works in production:**
- Tempo v2.10.1 (`/api/status/buildinfo` via `dev-gcp-tempo`) ≥ 2.6 floor.
- `POST /api/ds/query` `queryType:"traceql"`, `query:'{resource.service.name="X"} | quantile_over_time(duration,.99) by (name)'`, `step:"<window>s"` → 200.
- `span.http.route`/`method`/`status_code` are NOT populated fleet-wide
  (literal "nil") — the route lives in the span NAME. Probe dimensions live;
  don't hardcode semconv HTTP attrs.
- Confirmed working dimensions: `name`, `span.db.system`, `span.messaging.system`, built-in `status` (error-rate via `rate() by (dim, status)`, divide client-side; `errorRate()` is not valid syntax here).
- No instant mode: use step = window width, average the 2–3 buckets returned.
- Span-metrics fallback viable: `traces_spanmetrics_calls_total` carries
  `span_name, db_system, db_operation, status_code, span_kind`.

**Architecture constraint:** ServiceOverview passes resolved `tracesUid`/`logsUid` (not `environment`) to TracesTab/LogsTab — new endpoints take the
UID as a query param instead of re-resolving from env.

## Plan (files + shapes)

- `pkg/plugin/patterns.go`: `GET /services/{ns}/{svc}/logs/patterns?from&to&lokiUid&clusterFilter` — direct proxy GET, filter level=error, sum samples,
  sort desc cap 20; second call over the previous equal window → `isNew`;
  fallback on any error: LogQuery newest-1000 error lines clustered via
  `fingerprint.Normalize()`. Response `{mode: serverPatterns|sampled|unavailable, patterns: [{pattern, level, count, sample, firstSeenMs, lastSeenMs, isNew, filterLiteral}], note}`; `filterLiteral` = longest non-placeholder token ≥4 runes.
- `pkg/plugin/traceanalytics.go`: `GET /services/{ns}/{svc}/traces/breakdown?from&to&tracesUid&dimension&attr` — curated candidates (name, http.route,
  http.status_code, db.system, db.operation, messaging.system, rpc.method +
  ad-hoc attr), per-UID capability cache; TraceQL mode via a small local
  ds/query POST helper (DsQueryClient lacks Tempo's query/step fields — keep
  the helper file-local); `rate() by (attr, status)` + quantiles for the
  selected dimension; treat "nil" values as dimension-unavailable; sort p99
  desc. Fallback: span-metrics PromQL grouped by the Prom label, mirroring
  operations.go.
- `src/api/analytics.ts`: new file copying the client.ts fetch helpers
  (module-private there); `getLogPatterns` / `getTraceBreakdown`.
- `src/pages/tabs/logs/PatternsPanel.tsx` + LogsTab edit: bar list, NEW badge,
  mode badge ("server patterns" vs "sampled from newest 1000 error lines"),
  click → setLogSearch(filterLiteral).
- `src/pages/tabs/traces/TraceBreakdowns.tsx` + TracesTab edit: dimension
  Combobox, rate/error/p95/p99 table with mini bars, row click → span search.
- Tests: patterns_test.go / traceanalytics_test.go with fake proxy + dsquery
  servers per sessions_test.go's pattern.
