# Alert templates

**Stability: experimental.** Shapes may change without a deprecation window.

`GET /alert-templates/{kind}`

Returns a pre-filled Grafana alert-rule definition for a service, plus a deep
link into the Grafana "new alert rule" form with those defaults applied. The
plugin does **not** create the rule — it hands you a starting point. `GET` only,
never cached.

Base: `{GRAFANA_URL}/api/plugins/nais-apm-app/resources`.

### Path parameter — `{kind}`

| Kind | What it alerts on | Datasource |
| --- | --- | --- |
| `error-rate` | Service error rate over threshold | metrics (Mimir) |
| `exception-spike` | Spike in a specific exception hash | logs (Loki) |
| `web-vitals` | Web-vital regression (Faro) | metrics |
| `new-exceptions` | Exception types not seen in the previous 7 days (the `#65` "new-exceptions" semantics used by CI gates) | logs |
| `slo-burn-rate` | Multi-window SLO burn rate | metrics |

Any other kind → `404 {"error":"unknown alert template kind"}`.

### Query parameters

| Name | Applies to | Sanitization / default | Meaning |
| --- | --- | --- | --- |
| `service` | all | `MustSanitizeLabel`, **required** (else `400`) | Service name. |
| `namespace` | all | `ParseNamespace` | Namespace. |
| `environment` | all | `parseEnvironment` | Environment (drives the cluster label matcher). |
| `fingerprint` | exception kinds | `MustSanitizeLabel` | Issue fingerprint to scope the rule. |
| `hash` | `exception-spike` | CSV, each must match `^[a-zA-Z0-9]+$` | Exception hash(es); missing/invalid → `400 {"error":"missing or invalid hash"}`. |
| `window` | `slo-burn-rate` | `fast` (default) or `slow`; else `400 {"error":"window must be fast or slow"}` | Burn-rate window pair. |
| `slo` | `slo-burn-rate` | float in `[0.5, 0.999999]`, default `0.999` | SLO target. |

### Response — `alertTemplateResponse`

| Field | Type | Description |
| --- | --- | --- |
| `url` | string | `/alerting/new?defaults=<url-encoded JSON>` deep link. |
| `defaults` | object | The `ruleFormDefaults` payload (see below). |

**ruleFormDefaults**:

| Field | Type | Description |
| --- | --- | --- |
| `type` | string | Always `"grafana"`. |
| `name` | string | Suggested rule name. |
| `condition` | string | Ref id of the condition query (always `"C"`). |
| `evaluateFor` | string | Pending period, e.g. `"5m"`. |
| `queries` | array&lt;alertQuery&gt; | The A (data) / B (reduce) / C (threshold) query chain. |
| `annotations` | array&lt;{key,value}&gt; | Suggested annotations (summary, deep link). |
| `labels` | array&lt;{key,value}&gt; | `namespace`, `service`, `source=nais-apm`. |

**alertQuery**: `refId`, `queryType`, `relativeTimeRange` (`{from,to}` seconds
before now; present on the data query), `datasourceUid`, `model` (query model —
`expr` for the data query, reduce/threshold model for the expression queries).

### Datasource errors

- metrics kinds (`error-rate`, `web-vitals`, `slo-burn-rate`) →
  `503 {"error":"metrics datasource not configured"}`.
- logs kinds (`exception-spike`, `new-exceptions`) →
  `503 {"error":"logs datasource not configured"}`.

### Example

```bash
curl -s ".../alert-templates/new-exceptions?namespace=fager&service=min-side-arbeidsgiver&environment=prod"
```

```json
{
  "url": "/alerting/new?defaults=%7B%22type%22%3A%22grafana%22%2C...",
  "defaults": {
    "type": "grafana",
    "name": "New exception types – min-side-arbeidsgiver (prod)",
    "condition": "C",
    "evaluateFor": "5m",
    "queries": [
      {
        "refId": "A",
        "queryType": "",
        "relativeTimeRange": { "from": 600, "to": 0 },
        "datasourceUid": "nav-logs",
        "model": {
          "refId": "A",
          "expr": "sum by (hash, value) (count_over_time({service_name=\"min-side-arbeidsgiver\", kind=\"exception\", k8s_cluster_name=\"prod\"} | logfmt | hash!=\"\" | keep hash, value [30m])) unless on (hash) sum by (hash) (...)"
        }
      },
      { "refId": "B", "datasourceUid": "__expr__", "model": { "type": "reduce", "reducer": "last", "expression": "A", "refId": "B" } },
      { "refId": "C", "datasourceUid": "__expr__", "model": { "type": "threshold", "expression": "B", "refId": "C", "conditions": [ { "evaluator": { "type": "gt", "params": [0] } } ] } }
    ],
    "labels": [
      { "key": "namespace", "value": "fager" },
      { "key": "service", "value": "min-side-arbeidsgiver" },
      { "key": "source", "value": "nais-apm" }
    ]
  }
}
```

> The `new-exceptions` rule uses an approximate, stateless 7-day lookback:
> issues older than the lookback re-fire as "new", and regressions of resolved
> issues do not fire. See the annotation summary in the payload.
