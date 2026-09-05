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
| `format` | `new-exceptions` | `prometheusrule`; another known kind → `400`, unknown kind → `404` | Render a PrometheusRule manifest instead of the Grafana rule form (see below). |

### `format=prometheusrule` — the manifest variant

`GET /alert-templates/new-exceptions?service=…&format=prometheusrule` returns
`application/yaml`: a copy-pasteable `monitoring.coreos.com/v1 PrometheusRule`
a team commits next to their app, so a new issue reaches their Slack channel
through the alerting they already run — the plugin holds no Slack credential.

It is the same "not seen in the previous 7 days" detection as the Grafana
variant, translated from LogQL to PromQL over the shipped Mimir recording rule
`loki:apm:exception_sessions:count1m` (labels `service_namespace`,
`service_name`, `hash`). Those three label names are **constants** in the
backend, not `otelConfig` values: they are fixed by the recording rule in
helm-charts, so an override would silently select no series.

Labels `namespace` + `severity: warning` for routing. Annotations are the ones
nais's default Slack template renders: `summary` (grouped header — no
per-instance templating), `message` (rendered per result, carries
`{{ $labels.hash }}`), `consequence`, `action`, and `dashboard_url`.

`dashboard_url` is an **absolute** URL — a host-relative path is not clickable
from Slack. The base comes from Grafana's app URL (plugin context, falling back
to `GF_APP_URL`); when neither is set the manifest emits
`https://REPLACE-WITH-YOUR-GRAFANA` so the gap is visible rather than subtle.
The other four (in-Grafana) callers of `serviceDeepLink` keep the relative form.

**Faro/browser-only.** The recording rule filters `session_id!=""`, so a
backend-only app gets a rule that never fires. The manifest header carries a
`count(...)` query to verify the series exists in the tenant first.

The recording rule is per-cluster, so `environment` does not appear in the
expression or the annotation text — the environment watched is the cluster the
manifest is applied in.

Only `new-exceptions` supports it: another known kind returns
`400 {"error":"format=prometheusrule is only available for new-exceptions"}`,
and an unknown kind still returns `404` as it does without the param.

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
