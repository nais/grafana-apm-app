# Loki & Tempo features the plugin under-uses (given the current platform config)

> Complement to `docs/platform-pipeline-recommendations.md`. That doc asks for
> **pipeline changes**. This one is the reverse: **existing Loki/Tempo
> capabilities the plugin leaves on the table** with the LGTM config exactly as
> it stands today. Every item is grounded in (a) what the plugin does now
> (cited by file), and (b) what the datasource/config already enables (cited by
> `features/*/values.yaml` setting or a stable datasource capability).
>
> Two buckets:
> **A — Already enabled, just adopt** (no platform change; highest ROI).
> **B — Small config nudge first** (a datasource-provisioning or one-line
> config touch unlocks it).
>
> Config snapshot this is written against: `loki/values.yaml`
> `allow_structured_metadata: true` (:161), `pattern_ingester.enabled: true`
> (:60), `volume_max_series: 5000` (:162), the `loki:service:loglevel:count1m`
> recording rule grouped by `detected_level` (:427-436); `tempo/values.yaml`
> service-graphs processor with `enable_virtual_node_label: true` (:126) and
> `histogram_buckets` (:115), span-metrics + `local-blocks` with
> `flush_to_storage: true` (:110-113), `send_exemplars: true` (:163).

---

## Top 5 highest-ROI adoptions

### 1. Filter logs by `detected_level` structured metadata, not `| json | level` (Loki) — S

- **Today:** `src/pages/tabs/LogsTab.tsx:135-166` filters severity by parsing the
  body — `| json | level=~"error|ERROR|SEVERE|…"` — using a hand-maintained
  case-variant map (`SEVERITY_VARIANTS`, :55-62). That silently **excludes
  every non-JSON log** (Go `slog` text, plain sidecar output): a failed `| json`
  leaves `level` empty, so the line is dropped from the filtered view and from
  the `sum by (detected_level)` volume panel's severity pipeline.
- **Available:** `detected_level` is Loki-computed structured metadata,
  confirmed present in this cluster — the platform recording rule groups on it
  (`loki/values.yaml:427-436 loki:service:loglevel:count1m`) and the volume
  panel already does `sum by (detected_level)`. Structured metadata is usable as
  a bare label filter with no parser stage. **The plugin's own backend already
  proves this works**: `pkg/plugin/issues.go:484,489` filters server logs with
  `| detected_level=~"…"`.
- **Concrete use:** replace the LogsTab severity filter with
  `| detected_level=~"error|warn|…"`; delete `SEVERITY_VARIANTS`. Cheaper (no
  json parse), normalized casing, and it finally severity-filters plain-text
  logs.
- **Value:** correctness (plain-text severity filtering) + cheaper query.
  Currently doing it the hard/wrong way in the one place users actually read logs.

### 2. Report Web Vitals as p75 via `quantile_over_time`, not the mean (Loki) — S

- **Today:** `src/pages/tabs/frontend/queries/loki-builders.ts:50,62,81` computes
  LCP/INP/CLS as an **average**:
  `sum(sum_over_time(… | unwrap vital)) / sum(count_over_time(…))`.
- **Available:** `unwrap` + `quantile_over_time` are standard LogQL over the same
  logfmt-parsed measurement value; nothing extra needed
  (`allow_structured_metadata: true`). Google's Core Web Vitals are **defined at
  p75** ("good" LCP ≤ 2.5 s at the 75th percentile), so the mean understates a
  skewed distribution and doesn't match any published threshold.
- **Concrete use:** `quantile_over_time(0.75, {…} | logfmt | unwrap value [w])`
  for the headline vitals; keep mean only if explicitly labelled.
- **Value:** correctness — the numbers finally mean what "Web Vitals" means.

### 3. Surface uninstrumented dependencies as virtual nodes on the service map (Tempo) — M

- **Today:** `pkg/plugin/servicemap.go` builds edges from
  `traces_service_graph_request_total/_failed_total/_request_server_seconds_bucket`
  (`otelconfig.go:442-445`) and never references a `virtual_node` label.
  Uninstrumented/external peers reach the UI only indirectly via span-metrics
  peer attributes on the Dependencies page.
- **Available:** `tempo/values.yaml:126 enable_virtual_node_label: true` — the
  service-graphs processor stamps a `virtual_node` label on edges to
  uninstrumented/external services (DBs, third-party APIs, unmonitored callers).
  The companion pipeline doc even flags this as a "bonus finding" the plugin can
  rely on (P8). It is on **today**, unused.
- **Concrete use:** render virtual peers as distinct, labelled nodes on the
  service map instead of dropping or misattributing them.
- **Value:** the map stops lying by omission about the fleet's real edges.

### 4. Show client-observed vs server-observed edge latency (Tempo) — M

- **Today:** `otelconfig.go:442-445` models only `_request_server_seconds_bucket`;
  every service-map/dependency edge shows **server-side** p95 only
  (`servicemap.go:331-335`).
- **Available:** the service-graphs processor emits **both**
  `traces_service_graph_request_server_seconds` and
  `…_request_client_seconds` histograms by default (config enables service-graphs
  with `histogram_buckets`, `tempo/values.yaml:114-115`). The client series is
  already being written to Mimir; the plugin just never queries it.
- **Concrete use:** plot client-p95 next to server-p95 on an edge; the gap is
  network/queue/proxy time between caller and callee — a classic and otherwise
  invisible diagnostic.
- **Value:** turns a flat "call is slow" into "slow _on the wire_, not in the
  callee."

### 5. Use TraceQL structural operators for the "find traces for this issue/error" flows (Tempo) — M

- **Today:** every trace search is a single flat block. `src/pages/tabs/TracesTab.tsx:78-100`
  → `{resource.service.name=X && status=error && duration>=Nms && (name=~".."||span.http.route=~"..")}`;
  `src/utils/explore.ts:32-47` uses event-scope (`event:name="exception"`); the
  breakdown (`traceanalytics.go:265-267`) is `{service.name=X} | rate() by (attr, status)`.
  No structural operators (`>>`, `<<`, `~`), no descendant/ancestor filters, no
  span-level aggregates.
- **Available:** the datasource already accepts TraceQL (event-scope proves
  ≥ 2.6), so structural queries and span aggregates are in reach with no config
  change; `local-blocks` + `flush_to_storage: true` (`tempo/values.yaml:110-113`)
  back TraceQL metrics.
- **Concrete use:** "traces where _this_ service's span errored **and** has a
  descendant DB/HTTP span over X ms" →
  `{resource.service.name=X && status=error} >> {span.db.system!="" && duration>Xms}`.
  Links an error to the downstream span that caused it — a real root-cause jump
  from the Issues/Endpoints rows instead of a span-name regex.
- **Value:** sharper "why" navigation; reuses the engine already in use.

---

## Full findings table

Legend — **Bucket A** = already enabled, just adopt; **Bucket B** = small config nudge first.

| #   | Feature                                                                                         | What the plugin does today                                                                                                                                      | What's available (config / capability)                                                                                                                                                                   | Concrete plugin use                                                                                                     | Effort | Value                          | Bucket |
| --- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------ | ------ |
| 1   | **Loki `detected_level` as label filter**                                                       | LogsTab severity filter is `\| json \| level=~"error\|ERROR\|…"` with a hand-kept case map; drops non-JSON logs (`LogsTab.tsx:135-166`)                         | `detected_level` structured metadata is present (recording rule `loki/values.yaml:427-436`; used in volume `sum by`); backend already does `\| detected_level=~` (`issues.go:484,489`)                   | `\| detected_level=~"…"`, delete `SEVERITY_VARIANTS`; severity-filters plain-text logs too                              | S      | High (correctness + cheaper)   | A      |
| 2   | **Web Vitals p75 via `quantile_over_time`**                                                     | mean = `sum_over_time(unwrap)/count_over_time` (`loki-builders.ts:50,62,81`)                                                                                    | `unwrap`+`quantile_over_time` standard LogQL; CWV is defined at p75                                                                                                                                      | `quantile_over_time(0.75, … \| unwrap value [w])`                                                                       | S      | High (correctness)             | A      |
| 3   | **Service-graph virtual nodes**                                                                 | no `virtual_node` reference; uninstrumented deps only via span-metrics peers (`servicemap.go`)                                                                  | `tempo/values.yaml:126 enable_virtual_node_label: true` (on now)                                                                                                                                         | render external/uninstrumented peers as labelled nodes on the map                                                       | M      | High (map completeness)        | A      |
| 4   | **Client-side edge latency histogram**                                                          | only `_request_server_seconds_bucket` (`otelconfig.go:445`, `servicemap.go:331`)                                                                                | processor emits `_request_client_seconds` too (service-graphs enabled, `tempo/values.yaml:114-115`)                                                                                                      | plot client-p95 vs server-p95 → network/queue time on an edge                                                           | M      | High (new diagnostic)          | A      |
| 5   | **TraceQL structural operators / span aggregates**                                              | flat single-block selectors + `rate() by (attr)` only (`TracesTab.tsx:78-100`, `traceanalytics.go:265`)                                                         | full TraceQL (`>>`,`<<`,`~`, `count()/avg()`); event-scope already used, `local-blocks` flushed (`tempo:110-113`)                                                                                        | "error span with slow DB descendant" root-cause searches from Issues/Endpoints                                          | M–L    | High (root cause)              | A      |
| 6   | **Loki `detected_fields` / `detected_labels` API**                                              | not used; severity list hardcoded (`LogsTab.tsx:35-42`), pod list via `/label/k8s_pod_name/values` (:91)                                                        | `/loki/api/v1/detected_fields` enumerates parseable fields + cardinality (Explore-Logs backend); `allow_structured_metadata:true`                                                                        | power the dynamic log field selector (roadmap #37) and discover real level/field values instead of static lists         | M      | High (implements #37 natively) | A      |
| 7   | **Loki log-context in custom drawers**                                                          | ExceptionDrawer shows exception+breadcrumb lines by `session_id`; no surrounding-lines view (`ExceptionDrawer.tsx:189,336`)                                     | log context = `query_range` around a ts with `direction`; embedded Grafana logs panel already has a native context button                                                                                | "show ± N lines around this occurrence" in the drawer, or lean on the native panel context                              | M      | Medium                         | A      |
| 8   | **Loki `/index/volume(_range)` API**                                                            | volume panel scans chunks: `sum by (detected_level)(count_over_time())` (`LogsTab.tsx:145-155`); `index/stats` already used well (`scorecard.go:272`)           | `/loki/api/v1/index/volume` returns index-only byte/entry volume; `volume_max_series:5000` set (`loki:162`)                                                                                              | cheap log-volume sparkline on overview/logs header; cheaper "does it log?" probes                                       | M      | Medium (cheaper)               | A      |
| 9   | **Pattern ingester beyond error patterns**                                                      | `/loki/api/v1/patterns` filtered to error-level only, one panel (`patterns.go:199,249`)                                                                         | same endpoint returns all-level patterns + per-bucket sample volume series (`pattern_ingester.enabled:true`, `loki:60`)                                                                                  | all-level "log shape" overview and pattern-volume trend; noise detection                                                | S–M    | Medium                         | A      |
| 10  | **TraceQL metrics for Ops/Database tabs**                                                       | breakdown only: `rate()`/`quantile_over_time() by (one dim)` (`traceanalytics.go`)                                                                              | `local-blocks` flushed (`tempo:110-113`) → `count_over_time`, `min/max/avg/sum(attr)`, `compare()`                                                                                                       | duration-by-`db.name`/`db.statement` straight from Tempo; `compare()` for "what's different about slow traces"          | M      | Medium                         | A      |
| 11  | **trace↔logs correlation in custom UIs**                                                        | ExceptionDrawer / server-issue flows offer no trace jump; embedded panels inherit correlations                                                                  | `tracesToLogs` (filterByTraceID, `service.name`), Loki `derivedFields` TraceID→Tempo, `tracesToMetrics`, `exemplarTraceIdDestinations` all provisioned (`provisioning/datasources/nav-cloud.yaml:38-84`) | if an exception/log line carries `trace_id`, show "view trace"; for server issues, "logs for this trace"                | S–M    | Medium (closes the loop)       | A      |
| 12  | **Exemplar → trace on all RED panels**                                                          | set on overview/database/dependency-detail timeseries (`buildServiceScene.ts`, `database/scene.ts`, `DependencyDetail.tsx`); **not** on web-vitals/frontend RED | `send_exemplars:true` (`tempo:163`); Mimir exemplar storage sized (`mimir:22`)                                                                                                                           | verify exemplar:true on any remaining trace-linked RED timeseries (ServerTab is a table w/ explicit links — fine)       | S      | Low (largely done)             | A      |
| 13  | **Deep-links into Drilldown apps**                                                              | Logs Drilldown link shipped (`LogsTab.tsx:263-277`); Traces/Metrics Drilldown builders exist (`explore.ts:209-264`)                                             | apps preinstalled Grafana ≥ 12                                                                                                                                                                           | wire the existing Traces/Metrics Drilldown builders into the Traces/Overview tabs too                                   | S      | Low–Med                        | A      |
| 14  | **Distinct sessions-affected count**                                                            | retry ladder range→1h→15m→5m→1m because `count(hash×session_id)` blows `max_query_series` (`exceptions.go` `sessionsFallbackWindows`; `sessions.go:110-116`)    | LogQL has **no** native distinct-count; `max_query_series:5000` / `volume_max_series:5000` are exact (`loki:158,162`). `approx_topk` approximates topk, not distinct-count                               | no existing-feature fix — **needs the recording rule** already requested in `platform-pipeline-recommendations.md` P1.2 | —      | (High, but blocked)            | B      |
| 15  | **Group logs by span-metrics dimensions the map needs** (`client_namespace`/`server_namespace`) | derives namespaces from the spanmetrics service→ns map because the single `service_namespace` edge label is ambiguous (`servicemap.go:130-146`)                 | single `service.namespace` service-graph dimension only (`tempo:116-120`)                                                                                                                                | blocked until split client/server namespace dims added — see pipeline doc P8                                            | —      | (Med, blocked)                 | B      |

---

## Notes / non-findings (checked, nothing to change)

- **Structured-metadata exception filtering** is already adopted: `issues.go:30-40`
  queries `exception_type`/`exception_message` as bare structured-metadata label
  filters (no `| json`). The gap is producer-side (nothing populates them yet —
  pipeline doc P1.1), not a plugin under-use.
- **Pattern ingester** is already used for error patterns (`patterns.go`); it is
  correctly on (`loki:60,384`). Only the _breadth_ of use (row 9) is open.
- **`index/stats`** is already used for the cheap "does this service log?" probe
  (`scorecard.go:272`) — good; row 8 is the volume-sparkline extension, not a fix.
- **Exemplars** are already wired on the primary RED timeseries panels
  (row 12) — this is a "verify coverage," not a missing feature.
- **Logs Drilldown deep-link** already ships (row 13) — the open work is reusing
  the already-written Traces/Metrics Drilldown builders elsewhere.
- **Retention bounds to respect** (unchanged from pipeline doc): traces 7 d
  (`tempo:59`), Mimir metrics 30 d, Loki logs 90 d (`loki:174`) — an
  exemplar/trace jump older than 7 d silently misses.
