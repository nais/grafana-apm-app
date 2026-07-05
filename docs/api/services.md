# Services, health & topology

**Stability: experimental.** These are mature but intentionally not yet under the
additive-only promise — their series-bearing shapes are still tuned for the UI.

RED metrics and topology derived from span metrics (Mimir) and the service graph.
All `GET`. Base: `{GRAFANA_URL}/api/plugins/nais-apm-app/resources`.

Contents:
- [`GET /services`](#get-services)
- [`GET /health`](#get-health)
- [`GET /operations`](#get-operations)
- [`GET /endpoints`](#get-endpoints)
- [`GET /runtime`](#get-runtime)
- [Other experimental endpoints](#other-experimental-endpoints)

> **Point-in-time endpoints.** `operations`, `endpoints`, `runtime` (and `jobs`)
> evaluate an *instant* query at `to`. When querying historical mock/backfill
> data, set `to` inside the data window or you will get empty results.

---

## `GET /services`

`GET /services`

The service inventory with RED summaries and optional time series. Returns a
**JSON array** of `ServiceSummary`.

### Parameters

| Name | Sanitization / default | Meaning |
| --- | --- | --- |
| `namespace` | `MustSanitizeLabel` | Filter to a namespace. |
| `environment` | `parseEnvironment` | Filter to environment(s). |
| `services` | CSV of `ns/svc`, each half `MustSanitizeLabel` | Restrict to specific services. |
| `from` / `to` | epoch seconds, standard defaults | Range. |
| `step` | seconds, default 60, clamped up to keep ≤~50 points/series | Series resolution. |
| `withSeries` | `false` disables; anything else = true | Include `rateSeries`/`errorSeries`/`durationSeries`. |

Cached 30 s. `503 metrics datasource not configured` when no metrics datasource
is set. Empty array when span metrics are not detected.

### Response — array&lt;ServiceSummary&gt;

| Field | Type | Description |
| --- | --- | --- |
| `name` / `namespace` | string | Service reference. |
| `environment` | string? | Environment. |
| `sdkLanguage` / `framework` | string? | Detected SDK / framework. |
| `hasFrontend` / `isSidecar` / `hasServerSpans` | bool? | Capability flags. |
| `rate` | number | req/s. |
| `errorRate` | number | Error percentage. |
| `p95Duration` | number | p95 latency. |
| `durationUnit` | string | `s` or `ms`. |
| `rateSeries` / `errorSeries` / `durationSeries` | array&lt;{t,v}&gt;? | Time series (`t` = epoch, `v` = value); omitted when `withSeries=false`. |

### Example

```bash
curl -s ".../services?namespace=fager&withSeries=false&from=1783176000&to=1783180000"
```

```json
[
  {
    "name": "ekspertbistand-backend",
    "namespace": "fager",
    "environment": "prod",
    "sdkLanguage": "java",
    "framework": "Ktor",
    "rate": 85.876,
    "errorRate": 0,
    "p95Duration": 0,
    "durationUnit": "s"
  }
]
```

---

## `GET /health`

`GET /services/{namespace}/{service}/health`

RED summary for a single service with previous-period comparison and degradation
attribution.

### Parameters

`namespace`, `service` (path, service required); `environment`, `from`, `to`
(query); plus `serverSpans` (`=="true"`, default false — restrict to server-kind
spans). Cached 30 s.

### Response — `HealthSummary`

| Field | Type | Description |
| --- | --- | --- |
| `rate` / `errorRate` / `p95Duration` | number | Current RED metrics. |
| `durationUnit` | string | `s` / `ms`. |
| `prevRate` / `prevErrorRate` / `prevP95Duration` | number \| null | Previous-period values (nullable). |
| `degradedOps` | array&lt;DegradedOperation&gt;? | Operations flagged as degraded. |
| `degradedDeps` | array&lt;DegradedDependency&gt;? | Downstream dependencies flagged degraded. |
| `causeCategory` | string? | `downstream-likely` \| `mixed` \| `no-downstream-detected` \| `downstream-only`. |

`DegradedOperation` / `DegradedDependency` carry `rate`, `errorRate`,
`p95Duration`, `durationUnit`, `prevErrorRate`, `prevP95Duration`, plus
`errorAnomaly?`/`latencyAnomaly?` flags (and `spanName`/`spanKind` or
`name`/`type` respectively).

### Example

```bash
curl -s ".../services/teamsykmelding/syk-dig-backend/health?from=1783176000&to=1783180000"
```

```json
{
  "rate": 1.926,
  "errorRate": 0,
  "p95Duration": 0,
  "durationUnit": "s",
  "prevRate": 1.886,
  "prevErrorRate": null,
  "prevP95Duration": 0
}
```

---

## `GET /operations`

`GET /services/{namespace}/{service}/operations`

Per-span-name RED metrics. Returns a **JSON array** of `OperationSummary`.
Params: `namespace`, `service` (path), `environment`, `from`, `to`. Instant query
at `to`. Cached 30 s.

**OperationSummary**: `spanName`, `spanKind` (formatted), `spanKindRaw` (raw
label), `rate`, `errorRate`, `p50Duration`, `p95Duration`, `p99Duration`,
`durationUnit`.

```bash
curl -s ".../services/teamsykmelding/syk-dig-backend/operations?from=1783176000&to=1783180000"
```

```json
[
  { "spanName": "POST", "spanKind": "Client", "spanKindRaw": "SPAN_KIND_CLIENT", "rate": 0.005, "errorRate": 0, "p50Duration": 0.18, "p95Duration": 0.24, "p99Duration": 0.25, "durationUnit": "s" }
]
```

---

## `GET /endpoints`

`GET /services/{namespace}/{service}/endpoints`

RED metrics grouped by endpoint category. Params as `/operations`. Instant query
at `to`. Cached 30 s.

### Response — `EndpointGroups`

`http`, `grpc`, `database`, `messaging`, `internal`, `client` — each an
array&lt;EndpointSummary&gt; — plus `durationUnit`. Noisy static-asset routes are
filtered out of `http`/`client`.

**EndpointSummary**: `spanName`, `rate`, `errorRate`, `p50Duration`,
`p95Duration`, `p99Duration`, `durationUnit`, plus optional
`httpMethod`, `httpRoute`, `rpcService`, `rpcMethod`, `dbSystem`,
`messagingKind` (`Consumer`/`Producer`).

```bash
curl -s ".../services/teamsykmelding/syk-dig-backend/endpoints?from=1783176000&to=1783180000"
```

```json
{
  "http": [],
  "grpc": [],
  "database": [
    { "spanName": "syk-dig-backend", "rate": 0.963, "errorRate": 0, "p50Duration": 0, "p95Duration": 0, "p99Duration": 0, "durationUnit": "s", "dbSystem": "postgresql" }
  ],
  "messaging": [],
  "internal": [],
  "client": [],
  "durationUnit": "s"
}
```

---

## `GET /runtime`

`GET /services/{namespace}/{service}/runtime`

Runtime metrics (container + JVM / Node.js / Go / DB pool / Kafka), auto-detected
per language. Params: `namespace`, `service` (path), `environment`, `from`, `to`.
Instant query at `to`. Cached 30 s. Returns `{}` when nothing is discovered.

### Response — `RuntimeResponse`

Each category is a nullable object present only when detected:

| Field | Type | Description |
| --- | --- | --- |
| `container` | object? | CPU/memory usage vs requests/limits, restarts, pod count. |
| `jvm` | object? | Heap/non-heap, GC, threads, memory pools, GC types, versions. |
| `nodejs` | object? | Event-loop lag/utilization, heap, GC, handles. |
| `go` | object? | Goroutines, threads, mem alloc/sys, GC, fds. |
| `dbPool` | object? | `{ status, pools: [DBPool] }`. |
| `kafka` | object? | `{ status, topics: [KafkaTopic] }`. |

Every category has a `status` field (`detected` / `absent` / `error`). Numeric
units are documented per field in `pkg/plugin/runtime.go` (bytes, seconds,
cores, etc.).

### Example (trimmed)

```bash
curl -s ".../services/teamsykmelding/syk-dig-backend/runtime?from=1783176000&to=1783180000"
```

```json
{
  "container": {
    "status": "detected",
    "cpuUsage": 0.0078,
    "cpuRequests": 0.07,
    "memoryUsage": 1075317418.67,
    "memoryLimits": 2505397589.33,
    "restarts": 0,
    "podCount": 3,
    "desiredReplicas": 1
  },
  "jvm": {
    "status": "detected",
    "heapUsed": 45117964.09,
    "heapMax": 805306368,
    "gcPauseRate": 0.008,
    "threadsLive": 50,
    "threadStates": { "runnable": 15, "timed-waiting": 18, "waiting": 16 },
    "cpuCount": 16,
    "podCount": 3
  }
}
```

---

## Other experimental endpoints

These are registered and usable but lightly documented here; treat their shapes
as unstable and consult the Go source (`pkg/plugin/`) for field-level detail.

| Endpoint | Response (top level) | Notes |
| --- | --- | --- |
| `GET /services/{namespace}/{service}/dependencies` | `{ dependencies: [DependencySummary] }` | Downstream deps of a service (name, type, RED, `impact`). |
| `GET /services/{namespace}/{service}/connected` | `{ inbound: [ConnectedService], outbound: [ConnectedService] }` | Peer connections in/out. |
| `GET /services/{namespace}/{service}/graphql` | `{ detected, framework, operations, fetchers }` | GraphQL/DGS per-operation metrics; `{ "detected": false }` when none. |
| `GET /services/{namespace}/{service}/custom-metrics` | `{ metrics: [CustomMetric], truncated }` | App-defined metric families (capped at 50). |
| `GET /dependencies` | `{ dependencies: [DependencySummary] }` | Fleet-wide dependency rollup. |
| `GET /dependencies/{name}` | `{ dependency, upstreams, operations }` | One external dependency and its callers. Not cached. |
| `GET /namespaces/{namespace}/dependencies` | `{ dependencies: [NamespaceDependency] }` | Dependencies for a namespace. |
| `GET /namespaces/{namespace}/alerts` | `{ rules: [AlertRuleSummary], unavailable?, errorMessage? }` | Merged Mimir + Grafana alert rules for a namespace. Not cached. Does not enforce GET. |
| `GET /ops-watchlist`, `POST /ops-watchlist` | JSON array of `{ namespace, service }` | Read/replace the ops watchlist stored in plugin settings. POST body is a JSON array (≤1 MB). Not cached. |

### Example (dependencies)

```bash
curl -s ".../services/teamsykmelding/syk-dig-backend/dependencies?from=1783176000&to=1783180000"
```

```json
{
  "dependencies": [
    { "name": "127.0.0.1", "displayName": "postgresql (127.0.0.1)", "type": "postgresql", "rate": 0.153, "errorRate": 0, "p95Duration": 4.35, "durationUnit": "ms", "impact": 1 }
  ]
}
```
