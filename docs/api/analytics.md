# Analytics

**Stability: experimental.** Shapes may change without a deprecation window.

Two derived-analytics endpoints: log-pattern clustering (Loki) and trace
breakdown by dimension (Tempo, with a span-metrics fallback). Both are `GET`,
both require a datasource UID query parameter, and both degrade to a structured
`"mode": "unavailable"` body (HTTP 200) rather than erroring when their
datasource is missing. Cached 30 s.

Base: `{GRAFANA_URL}/api/plugins/nais-apm-app/resources`.

Contents:
- [`GET /logs/patterns`](#get-logspatterns)
- [`GET /traces/breakdown`](#get-tracesbreakdown)

---

## `GET /logs/patterns`

`GET /services/{namespace}/{service}/logs/patterns`

Clustered error-log patterns for a service. Prefers Loki's pattern ingester
(`/loki/api/v1/patterns`); if that is unavailable it falls back to sampling the
newest ~1000 error lines and clustering them locally.

### Parameters

| In | Name | Sanitization / default | Meaning |
| --- | --- | --- | --- |
| path | `service` | `MustSanitizeLabel`; empty → `400` | Service name. (`namespace` is accepted but unused here.) |
| query | `from` | epoch seconds, default `now-1h` | Range start. |
| query | `to` | epoch seconds, default `now` | Range end. |
| query | `lokiUid` | `^[a-zA-Z0-9_-]{1,64}$`; invalid/absent → `unavailable` | Loki datasource UID. |

Discover UIDs from `GET /api/datasources` (type `loki`).

### Response — `LogPatternsResponse`

| Field | Type | Description |
| --- | --- | --- |
| `mode` | string | `serverPatterns` (pattern ingester), `sampled` (local clustering), or `unavailable`. |
| `patterns` | array&lt;LogPattern&gt; | Up to 20 patterns. |
| `note` | string? | Provenance/status note. |

**LogPattern**:

| Field | Type | Description |
| --- | --- | --- |
| `pattern` | string | Clustered template (`<_>` placeholders). |
| `level` | string | Always `"error"`. |
| `count` | int64 | Summed occurrences in the window. |
| `sample` | string | Representative raw line (sampled mode only). |
| `firstSeenMs` / `lastSeenMs` | int64 | First/last seen (epoch ms). |
| `isNew` | bool | Absent in the preceding equal-length window (server mode). |
| `filterLiteral` | string | Longest ≥4-rune token, to seed a log search. |

### Example

```bash
curl -s ".../services/fager/min-side-arbeidsgiver/logs/patterns?lokiUid=nav-logs&from=1783090000&to=1783185000"
```

```json
{ "mode": "serverPatterns", "patterns": [], "note": "no error log patterns in range" }
```

When `lokiUid` is absent:

```json
{ "mode": "unavailable", "patterns": [], "note": "logs datasource not configured" }
```

---

## `GET /traces/breakdown`

`GET /services/{namespace}/{service}/traces/breakdown`

RED metrics (rate, error rate, p95/p99 latency) broken down by a chosen span
dimension. Uses Tempo TraceQL metrics when available (`mode: traceql`); otherwise
falls back to Mimir span metrics (`mode: spanmetrics`).

### Parameters

| In | Name | Sanitization / default | Meaning |
| --- | --- | --- | --- |
| path | `namespace`, `service` | standard (service required) | Service reference. |
| query | `from` / `to` | epoch seconds, standard defaults | Range. |
| query | `tracesUid` | `^[a-zA-Z0-9_-]{1,64}$`; invalid/absent → `unavailable` | Tempo datasource UID. |
| query | `dimension` | one of the curated keys below; invalid → `name` | Group-by dimension. |

Curated `dimension` values: `name`, `http.route`, `http.status_code`,
`db.system`, `db.operation`, `messaging.system`, `rpc.method`.

### Response — `TraceBreakdownResponse`

| Field | Type | Description |
| --- | --- | --- |
| `mode` | string | `traceql`, `spanmetrics`, or `unavailable`. |
| `dimension` | string | Active group-by key. |
| `dimensions` | array&lt;string&gt; | Curated dimensions that carry data for this service (UI options). |
| `rows` | array&lt;TraceBreakdownRow&gt; | Per-value breakdown. |
| `note` | string? | Status note. |

**TraceBreakdownRow**:

| Field | Type | Description |
| --- | --- | --- |
| `value` | string | Dimension value. |
| `rate` | number | Request rate (req/s). |
| `errorRate` | number | Error percentage (0–100). |
| `p95Ms` / `p99Ms` | number | Latency percentiles (ms). |

### Example

```bash
curl -s ".../services/fager/min-side-arbeidsgiver/traces/breakdown?tracesUid=dev-gcp-tempo&dimension=name&from=1783090000&to=1783185000"
```

```json
{
  "mode": "spanmetrics",
  "dimension": "name",
  "dimensions": ["name"],
  "rows": [],
  "note": "computed from span metrics (Tempo TraceQL metrics unavailable)"
}
```
