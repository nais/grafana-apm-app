# Pipeline changes that would better support the plugin

> Each recommendation is tied to a concrete friction point the plugin hits
> today (with the code that works around it), an impact, and whether it
> _simplifies the plugin_ (lets us delete a workaround) or _unlocks a new
> capability_. Ordered by value. The plugin is designed to degrade gracefully,
> so none of these are prerequisites — they remove workarounds and sharpen
> features.

## P1 — highest value

### 1. Normalize backend exception fields to semconv (Collector logs pipeline / Loki structured metadata)

- **Config check (CONFIRMED GAP):** Nothing in the pipeline extracts exception fields. The Collector `log_statements` in `opentelemetry-collector/templates/_helpers.tpl:256-261` only run `replace_pattern(log.body, "[0-9]{11}", ...)` (SSN scrub) — no `exception.type`/`message`/`stacktrace` parsing. The fluentd backend path (`loki/templates/clusterflow.yaml`) only drops empty/debug lines, masks SSNs, and sets `nais_app_name`/`nais_service_namespace` — no exception extraction. Loki's OTLP index labels (`loki/values.yaml:99-104`) promote only `k8s.cluster.name`, `service.name`, `service.namespace`, `deployment.environment` to stream labels, so an exception label could not be filtered even if emitted. **Enabling capability is already on:** `loki/values.yaml:161 allow_structured_metadata: true` — so the pipeline _can_ carry these as structured metadata; nothing populates them. The span-event `exception.message`/`exception.stacktrace` only get PII-scrubbing (`_helpers.tpl:247-248`), not promotion. The 3-shape probe is a real gap; the fix is low-friction because structured metadata is already enabled.
- **Friction:** `pkg/plugin/issues.go` runs **three** probes for server exceptions because backend logs arrive in incompatible shapes — OTLP semconv (`exception_type`), JSON logstash/pino (`message`/`msg` + `level`/`detected_level`), and plain text (fingerprinted from a sampled 200 lines, counts scaled). This is fragile (a fourth shape = another probe) and the plain-text path can only approximate counts.
- **Change:** a Collector/Alloy logs pipeline (or a platform logging convention) that emits `exception.type` / `exception.message` / `exception.stacktrace` as **structured metadata** on error logs, consistently across languages.
- **Impact:** collapses three probes to one label-filter query; exact counts instead of sampled scaling; higher-quality fingerprints (real type+message instead of xxh3-of-line); drops the bootstrap-noise heuristic. **Simplifies the plugin substantially.**

### 2. A distinct-session-count metric or recording rule (Loki/Mimir)

- **Config check (CONFIRMED GAP; recording-rule infra already exists):** `loki/values.yaml:158 max_query_series: 5000` — the 5000 limit is exact and real (also `volume_max_series: 5000` at :162). No session pre-aggregation rule exists; the only Loki recording rule is `loki:service:loglevel:count1m` (`loki/values.yaml:427-436`), which counts log lines per `detected_level`, not distinct sessions. **But the plumbing to add one is fully present:** the Loki ruler remote-writes to Mimir (`loki/values.yaml:110-130 rulerConfig.remote_write` → `mimir-nais`/`mimir-tenant`), and Mimir has ruler capacity (`mimir/values.yaml:25-26 ruler_max_rules_per_rule_group: 200`, `ruler_max_rule_groups_per_tenant: 1000`). So this is "add a rule to existing infra," not "build infra."
- **Friction:** `pkg/plugin/exceptions.go` `sessionsFallbackWindows` is a retry ladder (range→1h→15m→5m→1m) because `count(hash × session_id)` exceeds Loki's `max_query_series=5000` on chatty apps — the UI then honestly shows "Sessions (last Nm)" instead of the full range.
- **Change:** either raise `max_query_series` for the APM tenant, or (better) a **recording rule / metric** that pre-aggregates distinct sessions-affected per exception hash into Mimir.
- **Impact:** removes the fallback ladder and the windowed-approximation UI; session counts become exact over any range. **Simplifies the plugin and improves a headline number.**

### 3. Populate `http.route` (and semconv span attributes) on spans (instrumentation / Collector processor)

- **Config check (CONFIRMED GAP, two-part):** (a) `http.route` is **not** a span-metrics dimension — the full list in `tempo/values.yaml:129-144` is `service.name, service.namespace, k8s.cluster.name, server.address, http.status_code, http.response.status_code, http.host, db.system, db.name, db.operation, messaging.system, messaging.destination.name, messaging.operation, telemetry.sdk.language`. So even if instrumentation populated `http.route`, TraceQL-metrics still couldn't group by it until it's added here. Note `http.status_code` **is** already a dimension — the plugin's "nil fleet-wide" finding for it is instrumentation-side, not a dimension gap. (b) No processor derives `http.route` from span name: the Collector `transform` (`_helpers.tpl:230-242`) _normalizes_ `http.route` (UUID/ID replacement) only `where http.route != nil`, and separately normalizes `span.name` (strips query params, UUIDs, IDs, Next.js hashes) — it never sets route from the name. So route lives in the (normalized) span name. **Partial credit:** span-name normalization is already solid, so grouping by span name is stable; the missing piece is a real `http.route` attribute + its dimension.
- **Friction:** `pkg/plugin/traceanalytics.go` found `span.http.route`/`http.status_code` are **nil fleet-wide** — the route lives in the span _name_, so TraceQL-metrics breakdowns can't group by route. Detection also probes 7 dimensions live (3–11s each) to discover what's populated.
- **Change:** ensure instrumentation (or a Collector `transform`/`attributes` processor) sets `http.route` (and keeps db/messaging/rpc semconv attributes) on server spans.
- **Impact:** unlocks the "which route explains the p99" breakdown properly; lets the plugin ship a curated dimension list instead of probing. **Unlocks a capability.**

## P2 — meaningful

### 4. Add `app_version` as a span-metrics dimension (Collector spanmetrics connector)

- **Config check (CONFIRMED GAP):** No version/image dimension in the span-metrics dimensions list (`tempo/values.yaml:129-144`, full list above). The only `version` handling anywhere is `_helpers.tpl:283`, which sets a `version` datapoint attribute from `service.version` **only for the `management` cluster** (naisdevice) — irrelevant to tenant-app RED. So backend RED has no version dimension, confirmed.
- **Friction:** release-health / regression detection is **frontend-only** today (Faro `app_version` on exception lines). Backend RED has no version dimension, so "did this deploy regress error rate?" can't be answered for backend services from metrics.
- **Change:** add an app/image-version dimension to the spanmetrics connector output.
- **Impact:** backend release regression detection + per-version RED, matching what the Frontend tab already does. **Unlocks a capability.** (Watch cardinality — version × route can be large; scope to a coarse version label.)

### 5. Guarantee `app_version` on Faro exception/measurement lines (SDK + Alloy relabel)

- **Config check (CONFIRMED GAP):** The Alloy Faro pipeline (`alloy-faro/templates/config.yaml`) never relabels `app_version`. `stage.logfmt` extracts only `app_name`, `kind`, `page_url`, `page_id` (→ labels `app_name`, `kind`, plus static `env`); the exception branch extracts only `type` → `exception_type` (then drops it after the counter). The Faro SDK's `app.release` meta is referenced _only_ in a commented-out sourcemaps `location` block (`config.yaml:49-54`), i.e. used for source-map path templating, not turned into a stream label or log field. So no `app_version` reaches Loki on any Faro stream. Confirmed.
- **Friction:** the reconciliation found some frontend apps emit no `app_version`, so `/frontend/versions` and the version facet come back empty even with rich telemetry.
- **Change:** `@nais/apm` already sets `release` from the image/SHA — ensure the Alloy `faro.receiver` relabels it to a stable `app_version` label on every stream, and make the SDK's release resolution mandatory.
- **Impact:** the Releases panel and version facet work for every instrumented app. **Sharpens a shipped feature.**

### 6. Recording rules for wide-range plugin/alert queries (Mimir)

- **Config check (PARTIAL — infra + some rules exist, exception rules do not):** Recording-rule infrastructure is fully present and already in use. Tempo ships span-metrics recording rules (`tempo/values.yaml:507-535`: `spanmetrics:database:daily_p99_latency:1d`, `:span_p99_latency:5m`, `:span_p95_latency:5m`) and the full tempo-mixin rule/alert set (`:322-506`). Loki ruler emits `loki:service:loglevel:count1m` and remote-writes to Mimir (`loki/values.yaml:110-130, 427-436`). Mimir ruler capacity: 200 rules/group, 1000 groups/tenant (`mimir/values.yaml:25-26`). **What's missing** is any rule precomputing per-service exception-fingerprint sets / error ratios / 7d baselines. Reframe as "add the exception/error-ratio rules to the existing ruler," not net-new infra. **Caveat:** Mimir metrics retention is `compactor_blocks_retention_period: 30d` (`mimir/values.yaml:27`), so a "7d baseline" rule works but any baseline window >30d does not.
- **Friction:** the new-exceptions alert template runs `count_over_time(... [7d] offset 30m)` at **~11s/eval** on the chattiest app (`alerttemplates.go:338`); other wide aggregations are similarly heavy.
- **Change:** recording rules that precompute per-service exception-fingerprint sets / error ratios / 7d baselines.
- **Impact:** cheaper alert evaluation and faster plugin panels; less load on Loki/Mimir at query time.

### 7. Standardize connection-pool metrics on semconv `db.client.connections.*` (instrumentation)

- **Config check (N/A to pipeline — confirmed instrumentation-only):** The Collector does no metric renaming/relabeling. Its `metric_statements` (`_helpers.tpl:262-292`) only set datapoint attributes (`app`, `namespace`, `container`, `pod`, `node`, `k8s_cluster_name`, `collector_name`) and clamp future timestamps — no metric-name rewrites (the `http.route` cardinality-reduction lines are commented out, `:290-292`). So the dual HikariCP/OTel pool families are purely instrumentation-side; the pipeline neither helps nor hurts. Leave as-is.
- **Friction:** `pkg/plugin/runtime.go` queries **two** metric families — legacy HikariCP (`hikaricp_connections_*`, label `pool`) and OTel (`db_client_connections_*`, label `pool_name`) — and merges/dedupes them because the fleet emits a mix.
- **Change:** converge on the OTel semconv family (`pool_name`) fleet-wide.
- **Impact:** the plugin drops the dual-family query + merge. **Simplifies the plugin.**

### 8. Consistent namespace labels on service-graph metrics (Collector servicegraph connector)

- **Config check (CONFIRMED GAP):** The service-graphs processor (`tempo/values.yaml:114-127`) has dimensions `service.name, service.namespace, db.system, messaging.system` and peer_attributes `peer.service, db.name, db.system, messaging.destination.name` — a **single** `service.namespace` dimension, no `client_namespace`/`server_namespace` split. That single label is exactly the ambiguity the plugin found (stamped from whichever span carried the resource attribute). Confirmed. **Bonus finding:** `enable_virtual_node_label: true` (`:126`) is set — the graph does surface uninstrumented/external peers as virtual nodes, which the plugin can rely on.
- **Friction:** `pkg/plugin/servicemap.go` found `service_namespace` on `traces_service_graph_request_total` is stamped from _whichever_ span (client OR server) carried resource attributes — inconsistent — so the clustered map derives namespaces from the spanmetrics service→namespace map instead of trusting the edge labels.
- **Change:** emit stable `client_namespace` / `server_namespace` on service-graph edges.
- **Impact:** exact cross-namespace edge attribution on the clustered map; drops a derivation step.

## P3 — nice to have

- **Exemplars on spanmetrics histograms (Tempo metrics-generator / Collector):** **Config check (ALREADY DONE — drop from list):** exemplars are configured end-to-end. `send_exemplars: true` on the metrics-generator remote_write (`tempo/values.yaml:163`, and both branches of `tempo/Feature.yaml:87,106`), and Mimir sizes exemplar storage generously (`mimir/values.yaml:22 max_global_exemplars_per_user: 10000000`; native histograms also on). The Tempo span-metrics processor attaches trace-ID exemplars by default and they ship to Mimir. So the plugin's `exemplar: true` will resolve. **Only caveat:** Tempo trace retention is 7d (`tempo/values.yaml:59 retention: 168h`), so an exemplar older than 7d points at a trace that's been compacted away — the metric→trace jump silently fails beyond that window. No pipeline change needed; keep this as a note, not an ask.
- **Retain metric HELP/UNIT metadata (Mimir ingester config):** **Config check (CONFIRMED — not tuned, defaults apply):** no explicit metadata-retention setting in `mimir/values.yaml` (`max_metadata_per_user`, metadata retention, etc. are all unset → Mimir defaults). `metadata-cache` is enabled (`:215`) but that's query caching, not ingester retention. Mitigating factor: `otel_metric_suffixes_enabled: true` (`:29`) encodes the UNIT into the metric-name suffix, so unit survives even if `/api/v1/metadata` HELP is thin. Keep as nice-to-have; the ask is to set explicit metadata limits/retention.
- **Replay/measurement stream retention tiering (Loki):** **Config check (CONFIRMED GAP — producer side already staged):** Loki has only global retention — `tableManager.retention_period: "90d"` (`loki/values.yaml:174`) with `compactor.retention_enabled: true` (`:167`); there is **no** `retention_stream` per-`kind` override anywhere. Meanwhile the Alloy Faro pipeline already relabels replay chunks onto `kind="replay"` (`alloy-faro/templates/config.yaml:108-126`, behind `replay.enabled`) and its own comment notes this is so replay "can carry its own (shorter) retention via a Loki `retention_stream` override" — but that override is not present in the Loki config. So the producer-side label exists; the Loki retention tier to exploit it does not. Also note `kind=exception`/`kind=event` history is capped at the global 90d.
- **Pattern ingester (Loki):** **Config check (ALREADY DONE — confirmed on):** `loki/values.yaml:60-66 pattern_ingester.enabled: true` plus the `patternIngester` deployment (`:384-407`, `enabled: true`, 2 replicas, persistence). Confirmed running. Keep it on.

## Newly discovered pipeline constraints (the draft missed these)

These are settings the actual config reveals that shape or limit what the plugin can see — worth knowing even where no change is requested.

- **Noisy-endpoint spans are dropped before metrics/traces (`_helpers.tpl:294-310`, `filter/drop_noisy_trace_urls`):** GET spans to `favicon.ico`, `*is_ready`/`*is_alive`, `*prometheus`, `*metrics`, `*actuator*`, `*internal/health|status|alive|ready*` are filtered out in the traces pipeline. The plugin will **never** see these routes in traces or span-metrics. Any "missing health-check route" is by design, not a bug.
- **Span-metrics filter policies (`tempo/values.yaml:146-156`):** span-metrics are generated only for `SPAN_KIND_CLIENT|SERVER|CONSUMER|PRODUCER` (INTERNAL spans get **no** RED metrics) and **exclude** `resource.service.name == "nais-ingress"`. So ingress-level RED is absent from span-metrics.
- **Legacy service-name env-suffix stripping (`_helpers.tpl:223,255,268`):** `service.name` matching `^(.+?)-[tqu][0-5]$` (e.g. `-t0`…`-u5`) has the suffix stripped when `deployment.environment.name` is set. Service identity the plugin joins on is already normalized this way — expect merged identities for legacy apps.
- **Aggressive span-name normalization (`_helpers.tpl:230-233`):** query strings, UUIDs, 6+-digit IDs, and Next.js data-URL hashes are stripped from `span.name`. Good for cardinality/grouping stability, but the plugin cannot recover raw paths from span name.
- **Loki OTLP stream labels are a fixed short list (`loki/values.yaml:99-104`):** only `k8s.cluster.name`, `service.name`, `service.namespace`, `deployment.environment` become index/stream labels. Any other attribute the plugin wants to `{}`-filter on (e.g. exception type, level) is **not** a stream label unless promoted — directly constrains P1.1.
- **Metrics-generator registry staleness (`tempo/values.yaml:108-109`):** `collection_interval: 1m`, `stale_duration: 1m` — a series with no data for ~1m goes stale. Low-traffic services can show gaps in RED continuity.
- **Retention windows the plugin must respect:** traces 7d (`tempo/values.yaml:59`), Mimir metrics 30d (`mimir/values.yaml:27`), Loki logs 90d (`loki/values.yaml:174`). Issue/triage history and any exemplar/trace jump are bounded by these.
- **`filter/drop_opencode_logs` (`_helpers.tpl:311-315`):** logs from `service.name` `opencode` or `github-copilot` are dropped entirely — minor, but those services have no logs in Loki.

## What the plugin already owns deliberately (do NOT push upstream)

- **Query-time fingerprinting** (`pkg/plugin/fingerprint`) is intentionally plugin-side, not an Alloy-computed field, so it applies **retroactively** to historical data and can be versioned without re-ingest. Emitting better _raw_ exception fields (P1.1) helps it; moving the fingerprint computation into the pipeline does not.
- **Triage state** stays in Grafana annotations, not the LGTM stack (see `docs/adr/0001`).
