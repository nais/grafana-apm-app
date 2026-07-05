# Platform

Fleet- and service-level platform endpoints: datasource/feature detection,
readiness scorecard, jobs/cronjobs, and the service-map topology.

`GET /capabilities` is **stable**; the rest are **experimental**.

Base: `{GRAFANA_URL}/api/plugins/nais-apm-app/resources`.

Contents:
- [`GET /capabilities`](#get-capabilities) — stable
- [`GET /scorecard`](#get-scorecard)
- [`GET /jobs`](#get-jobs)
- [`GET /service-map`](#get-service-map)
- [`GET /service-map/clustered`](#get-service-mapclustered)

---

## `GET /capabilities`  (stable)

`GET /capabilities`

What the plugin detected about the configured datasources: span metrics, service
graph, Tempo/Loki/Pyroscope availability, and the list of discovered services.
Health checks and UI bootstrapping call this first.

### Parameters

None.

### Caching

Uses a dedicated capability cache (**5 min** positive TTL, **30 s** negative TTL
when no span metrics are detected). This cache is process-global and **not**
org-scoped, and it does **not** emit an `X-Cache` header.

### Response — `Capabilities`

| Field | Type | Description |
| --- | --- | --- |
| `spanMetrics` | object | `{ detected, namespace?, callsMetric?, durationMetric?, durationUnit? }`. |
| `serviceGraph` | object | `{ detected, prefix? }`. |
| `tempo` | object | `{ available, error? }`. |
| `loki` | object | `{ available, error? }`. |
| `pyroscope` | object | `{ available, uid? }`. |
| `services` | array&lt;string&gt; | Discovered service names. |
| `environments` | array&lt;string&gt;? | Discovered environment values. |
| `tempoByEnv` | object? | Per-environment Tempo status. |
| `lokiByEnv` | object? | Per-environment Loki status. |

### Example

```bash
curl -s ".../capabilities"
```

```json
{
  "spanMetrics": {
    "detected": true,
    "namespace": "traces_spanmetrics",
    "callsMetric": "traces_spanmetrics_calls_total",
    "durationMetric": "traces_spanmetrics_latency_bucket",
    "durationUnit": "s"
  },
  "serviceGraph": { "detected": true, "prefix": "traces_service_graph" },
  "tempo": { "available": true },
  "loki": { "available": true },
  "services": ["aareg-behandling", "abac-arena", "min-side-arbeidsgiver"]
}
```

---

## `GET /scorecard`

`GET /services/{namespace}/{service}/scorecard`

An observability-readiness scorecard for a service (6 checks) plus nais Console
ownership enrichment.

### Parameters

`namespace`, `service` (path, service required); `environment` (query). Cached
**5 min** (dedicated scorecard cache; `X-Cache: HIT` on hit).

### Response — `ScorecardResponse`

| Field | Type | Description |
| --- | --- | --- |
| `readiness` | object | `{ score int, total int, checks: [ScorecardCheck] }`. |
| `console` | object | nais Console enrichment (see below). |

**ScorecardCheck**: `key` (string), `label` (string), `ok` (bool), `hint`
(string). The six checks, in order: `spanMetrics`, `traces`, `logs`,
`runtimeMetrics`, `browserTelemetry`, `alertRules`.

**console** (`ScorecardConsole`): `configured` (bool), `teamSlug?`,
`slackChannel?`, `repositoryUrl?`, `ingresses?` (array&lt;string&gt;).
`configured` is `false` when the nais Console API is not set up on the install.

### Example

```bash
curl -s ".../services/fager/min-side-arbeidsgiver/scorecard"
```

```json
{
  "readiness": {
    "score": 5,
    "total": 6,
    "checks": [
      { "key": "spanMetrics", "label": "Span metrics (RED)", "ok": true, "hint": "Enable auto-instrumentation in your nais manifest..." },
      { "key": "traces", "label": "Traces in Tempo", "ok": true, "hint": "Export OTLP traces to the collector..." },
      { "key": "browserTelemetry", "label": "Browser telemetry (Faro)", "ok": true, "hint": "Instrument your frontend with @nais/apm (Faro)..." }
    ]
  },
  "console": { "configured": false }
}
```

---

## `GET /jobs`

`GET /jobs`

Kubernetes Job/CronJob status across the fleet, derived from kube-state-metrics.

### Parameters

| Name | Sanitization / default | Meaning |
| --- | --- | --- |
| `namespace` | `MustSanitizeLabel`; empty = all namespaces | Scope to a namespace. |
| `from` / `to` | epoch seconds, standard defaults | Only `to` (the snapshot instant) is used; the range scopes the cache key. |

Cached 30 s. Returns `503 metrics datasource not configured` if no metrics
datasource is set.

### Response — `JobsResponse`

| Field | Type | Description |
| --- | --- | --- |
| `available` | bool | `false` when KSM job metrics are absent. |
| `jobs` | array&lt;JobEntry&gt; | Job/cronjob rows. |
| `note` | string? | Explanation when unavailable. |

**JobEntry**: `name`, `namespace`, `cluster`, `kind` (`CronJob`/`Job`),
`schedule?`, `timezone?`, `lastRun?` (`{outcome, startMs?, completionMs?,
durationSec?, reason?}`), `lastScheduleMs?`, `nextScheduleMs?`, `failureStreak`
(int), `status` (`ok`/`failing`/`unknown`), `runCount` (int).

### Example

```bash
curl -s ".../jobs"
```

```json
{
  "available": true,
  "jobs": [
    {
      "name": "eux-rina-gateway-parity-test-q1",
      "namespace": "eessibasis",
      "cluster": "dev",
      "kind": "CronJob",
      "schedule": "0 0 1 1 *",
      "timezone": "local",
      "lastRun": { "outcome": "failed", "startMs": 1783136474000, "reason": "BackoffLimitExceeded" },
      "failureStreak": 1,
      "status": "failing",
      "runCount": 1
    }
  ]
}
```

---

## `GET /service-map`

`GET /service-map`

A node/edge topology graph, either for the whole fleet or focused on one service
(with multi-hop BFS expansion).

### Parameters

| Name | Sanitization / default | Meaning |
| --- | --- | --- |
| `service` | `MustSanitizeLabel` | Focus node. |
| `namespace` | `MustSanitizeLabel` | Focus namespace. |
| `environment` | `parseEnvironment` | Environment filter. |
| `from` / `to` | epoch seconds, standard defaults | Range. |
| `depth` | int clamped to `[1,3]`, default 1 | BFS hops (only when `depth>1` and `service` set). |
| `debug` | `=="1"` bypasses cache | Returns multi-hop debug output when combined with `depth>1` + `service`. |

Cached 30 s (except `debug`).

### Response — `ServiceMapResponse`

`{ "nodes": [ServiceMapNode], "edges": [ServiceMapEdge] }`.

**ServiceMapNode**: `id`, `title`, `subtitle?`, `mainStat?`, `secondaryStat?`,
`arc__errors` (number), `arc__ok` (number), `nodeType?`, `isSidecar?`, `isHub?`,
`hubDegree?`, `callerCount?`, `errorRate` (number), `serviceCount?`.
The `arc__errors`/`arc__ok` and `mainStat`/`secondaryStat` fields follow
Grafana's node-graph panel contract.

**ServiceMapEdge**: `id`, `source`, `target`, `mainStat?`, `secondaryStat?`.

### Example

```bash
curl -s ".../service-map?service=min-side-arbeidsgiver&namespace=fager&from=1783176000&to=1783180000"
```

```json
{
  "nodes": [
    { "id": "tiltaksgjennomforing-api.prod-fss-pub.nais.io", "title": "tiltaksgjennomforing-api.prod-fss-pub.nais.io", "mainStat": "0.0 req/s", "secondaryStat": "0.0% errors", "arc__errors": 0, "arc__ok": 1, "nodeType": "service", "callerCount": 1, "errorRate": 0 }
  ],
  "edges": [
    { "id": "min-side-arbeidsgiver->idporten.no", "source": "min-side-arbeidsgiver", "target": "idporten.no", "mainStat": "0.0 req/s" }
  ]
}
```

---

## `GET /service-map/clustered`

`GET /service-map/clustered`

The fleet-wide topology aggregated by **namespace** (one node per namespace).
Same `ServiceMapResponse` shape; nodes carry `serviceCount` and namespace-level
rollups. Params: `environment`, `from`, `to`. Cached 30 s.

### Example

```bash
curl -s ".../service-map/clustered?from=1783176000&to=1783180000"
```

```json
{
  "nodes": [
    { "id": "teamarenanais", "title": "teamarenanais", "subtitle": "58 services", "mainStat": "0.1 req/s", "secondaryStat": "0.0% errors", "arc__errors": 0, "arc__ok": 1, "nodeType": "service", "callerCount": 2, "errorRate": 0, "serviceCount": 58 }
  ],
  "edges": []
}
```
