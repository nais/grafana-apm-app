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
| `new-exceptions` | Frontend exception hashes not seen in the previous 7 days | metrics (Mimir recording rule) |
| `slo-burn-rate` | Multi-window SLO burn rate | metrics |
| `crash-loop-back-off` | Container in CrashLoopBackOff for 5 minutes, across the selected namespace | metrics (kube-state-metrics) |
| `custom` | Blank query and name, with routing context pre-filled | metrics (initial selection) |

Any other kind → `404 {"error":"unknown alert template kind"}`.

The service page's Alerts tab offers Custom alert, CrashLoopBackOff,
New frontend exceptions and Web Vitals (LCP), plus an Exception spike card linking to Issues. The
"Alert on new frontend exceptions" section offers a PrometheusRule managed as
code alongside the app, unlike the templates saved in Grafana. Notifications
follow the team's existing alert routing; Slack delivery depends on that
configuration. Error-rate and SLO burn-rate endpoints remain available to existing callers.

`new-exceptions` uses PromQL over `loki:apm:exception_sessions:count1m` in Mimir,
scoped to the selected service, namespace and data environment (`k8s_cluster_name`).
It shares the 30m-versus-preceding-7d detection builder with the PrometheusRule
variant. Each hash produces a separate alert instance above zero for 5 minutes.
The query is instant; an empty result is normal (`noDataState=OK`), while query
errors remain errors (`execErrState=Error`). Verify the recording rule is
producing series before relying on it: missing telemetry also yields no data.
Unlike the former Loki template, this requires the recording rule rather than
a configured logs datasource. Existing saved Grafana rules are not modified.

`crash-loop-back-off` uses the selected data environment as `k8s_cluster_name`
and the team as Kubernetes `namespace`. It preserves `pod` and `container`
labels for separate alert instances, with a threshold above zero for 5 minutes.
It watches **all pods in the namespace**, not only the current service, and
requires `kube_pod_container_status_waiting_reason` in the metrics datasource.

`custom` pre-fills routing labels, `severity=warning`, the APM service link,
and the existing team folder when a unique match is found. Name and query are
empty; the developer must supply both and review the condition and pending
period in Grafana. The initial datasource is the environment's metrics
datasource, with a starter condition above zero for 5 minutes. Routing labels
do not filter the query: the developer must scope it to the intended app and
environment.

### Query parameters

| Name | Applies to | Sanitization / default | Meaning |
| --- | --- | --- | --- |
| `service` | all | `MustSanitizeLabel`, **required** (else `400`) | Service name. |
| `namespace` | Grafana rules | `ParseNamespace`, required | Team slug; emitted as both `namespace` and `team` labels. |
| `environment` | Grafana rules | `parseEnvironment`, exactly one required | Data environment name used in the query's cluster matcher and APM link; the `env` notification label uses `alertRoutingEnvironments` when configured. |
| `fingerprint` | exception kinds | `MustSanitizeLabel` | Issue fingerprint to scope the rule. |
| `hash` | `exception-spike` | CSV, each must match `^[a-zA-Z0-9]+$` | Exception hash(es); missing/invalid → `400 {"error":"missing or invalid hash"}`. |
| `window` | `slo-burn-rate` | `fast` (default) or `slow`; else `400 {"error":"window must be fast or slow"}` | Burn-rate window pair. |
| `slo` | `slo-burn-rate` | float in `[0.5, 0.999999]`, default `0.999` | SLO target. |
| `format` | `new-exceptions` | `prometheusrule`; another known kind → `400`, unknown kind → `404` | Render a PrometheusRule manifest instead of the Grafana rule form (see below). |

Grafana rule templates require a team and exactly one environment. An
unscoped or multi-environment request returns `400` rather than pre-filling a
rule that would miss the `team` + `env` notification route. The
`format=prometheusrule` variant retains its existing optional parameters and
routes through the team's own alerting setup instead.

The template only opens Grafana's rule editor. Leave direct contact-point
selection unset so notification policies apply, and check **Preview routing**
with `team=<slug>` and `env=<routing environment>` before saving. In NAV Cloud,
`environment=prod` queries `k8s_cluster_name="prod"`, but its configured
`alertRoutingEnvironments.prod=prod-gcp` emits `env=prod-gcp` for the Console
notification policy. Existing rules are not changed by updating these templates;
audit their labels and direct
contact-point settings separately. The global default contact point has no
integrations and cannot be relied on as a Slack fallback.

Grafana templates preselect the existing team folder when exactly one folder
title matches the team slug exactly (case-sensitive). For example, `NAIS` does
not match the team slug `nais`. If no folder matches, the lookup fails, or several
folders match, choose the folder in Grafana's editor before saving; the plugin
does not create folders.

All Grafana templates set the required `severity` label: `warning` for
error-rate, exception-spike, crash-loop-back-off and custom, `info` for new-exceptions and web-vitals,
`critical` for fast SLO burn, and `warning` for slow SLO burn.

### `format=prometheusrule` — the manifest variant

`GET /alert-templates/new-exceptions?service=…&format=prometheusrule` returns
`application/yaml`: a copy-pasteable `monitoring.coreos.com/v1 PrometheusRule`
a team commits next to their app, so a new issue reaches their Slack channel
through the alerting they already run — the plugin holds no Slack credential.

It is the same "not seen in the previous 7 days" detection as the Grafana
variant, using the same PromQL detection over the shipped Mimir recording rule
`loki:apm:exception_sessions:count1m` (labels `service_namespace`,
`service_name`, `k8s_cluster_name`, `hash`). Those label names are **constants** in the
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
| `noDataState` | string (optional) | `"OK"` for new-exceptions, where no matching hashes is normal. |
| `execErrState` | string (optional) | `"Error"` for new-exceptions; datasource failures are not healthy results. |
| `queries` | array&lt;alertQuery&gt; | The A (data) / B (reduce) / C (threshold) query chain. |
| `annotations` | array&lt;{key,value}&gt; | Suggested annotations (summary, deep link). |
| `labels` | array&lt;{key,value}&gt; | `namespace`, `team`, `env` (mapped routing environment), `service`, `severity` (`critical`, `warning`, or `info`), `source=nais-apm`. |
| `folder` | {title,uid} (optional) | Existing Grafana folder with a unique title matching the team slug; omitted when there is no unique match. |

**alertQuery**: `refId`, `queryType`, `relativeTimeRange` (`{from,to}` seconds
before now; present on the data query), `datasourceUid`, `model` (query model —
`expr` for the data query, reduce/threshold model for the expression queries).

### Datasource errors

- metrics kinds (`error-rate`, `web-vitals`, `slo-burn-rate`, `crash-loop-back-off`, `custom`, `new-exceptions`) →
  `503 {"error":"metrics datasource not configured"}`.
- logs kinds (`exception-spike`) →
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
    "name": "New frontend exceptions – min-side-arbeidsgiver (prod)",
    "condition": "C",
    "evaluateFor": "5m",
    "noDataState": "OK",
    "execErrState": "Error",
    "queries": [
      {
        "refId": "A",
        "queryType": "",
        "relativeTimeRange": { "from": 600, "to": 0 },
        "datasourceUid": "nav-metrics",
        "model": {
          "refId": "A",
          "expr": "sum by (service_namespace, service_name, k8s_cluster_name, hash) (sum_over_time(loki:apm:exception_sessions:count1m{service_namespace=\"fager\", service_name=\"min-side-arbeidsgiver\", k8s_cluster_name=\"prod\"}[30m])) unless on (service_namespace, service_name, k8s_cluster_name, hash) sum by (service_namespace, service_name, k8s_cluster_name, hash) (count_over_time(loki:apm:exception_sessions:count1m{service_namespace=\"fager\", service_name=\"min-side-arbeidsgiver\", k8s_cluster_name=\"prod\"}[7d] offset 30m))",
          "instant": true,
          "range": false
        }
      },
      { "refId": "B", "datasourceUid": "__expr__", "model": { "type": "reduce", "reducer": "last", "expression": "A", "refId": "B" } },
      { "refId": "C", "datasourceUid": "__expr__", "model": { "type": "threshold", "expression": "B", "refId": "C", "conditions": [ { "evaluator": { "type": "gt", "params": [0] } } ] } }
    ],
    "labels": [
      { "key": "namespace", "value": "fager" },
      { "key": "team", "value": "fager" },
      { "key": "env", "value": "prod-gcp" },
      { "key": "service", "value": "min-side-arbeidsgiver" },
      { "key": "source", "value": "nais-apm" },
      { "key": "severity", "value": "info" }
    ]
  }
}
```

> The `new-exceptions` rule uses an approximate, stateless 7-day lookback:
> issues older than the lookback re-fire as "new", and regressions of resolved
> issues do not fire. See the annotation summary in the payload.
