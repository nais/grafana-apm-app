# Data-conformance review

A repeatable check that the plugin's backend queries match the data that
actually exists in the production-proxied datasources (Mimir `nav-metrics`,
Loki `nav-logs`, Tempo `dev-gcp-tempo`).

The goal is to catch three failure classes:

- **error** — an endpoint returns a non-200 / malformed payload;
- **empty-when-data-exists** — an endpoint returns nothing while the underlying
  datasource clearly has data;
- **nonsense values** — an endpoint returns internally inconsistent numbers
  (e.g. `idle > max` on a connection pool).

## Running the harness

```bash
bash scripts/data-review.sh
```

Env overrides (all optional):

| var          | default                 | meaning                              |
|--------------|-------------------------|--------------------------------------|
| `HOST`       | `http://localhost:3000` | Grafana base URL                     |
| `AUTH`       | `admin:admin`           | basic-auth `user:pass`               |
| `LOKI_UID`   | `nav-logs`              | logs datasource uid (patterns param) |
| `TEMPO_UID`  | `dev-gcp-tempo`         | traces datasource uid (breakdown)    |
| `RANGE_SECS` | `21600` (6h)            | lookback window                      |
| `MAXTIME`    | `60`                    | per-request curl timeout (seconds)   |
| `MATRIX_FILE`| built-in                | TSV file overriding the service matrix |
| `VERBOSE`    | `0`                     | set `1` to print body snippets on FAIL |

Example against a remote / different auth:

```bash
HOST=https://grafana.example AUTH='svc:token' RANGE_SECS=3600 bash scripts/data-review.sh
```

Exit code is `0` when every assertion passes, `1` otherwise. Each line prints
`PASS`/`FAIL`; a summary and a failure list are printed at the end.

> Note: `traces/breakdown` can be slow for a service whose result is not yet
> cached (see finding T-1). Keep `MAXTIME` generous or narrow the matrix.

## What the harness covers

Global endpoints (once): `/capabilities`, `/services`, `/jobs`,
`/service-map/clustered`, and all five `/alert-templates/{error-rate,
exception-spike,web-vitals,new-exceptions,slo-burn-rate}`.

Per service in the matrix: `/health`, `/issues`, `/exceptions/groups`,
`/triage`, `/frontend` (metrics), `/frontend/sessions`, `/frontend/versions`,
`/feedback`, `/logs/patterns`, `/traces/breakdown`, `/scorecard`, `/runtime`,
`/endpoints`.

Assertions are two-tier: every endpoint gets a **schema check** (HTTP 200 +
required keys), and endpoints flagged in the matrix additionally get a
**non-empty / coherence check**:

- `issues`      — issues array must be non-empty
- `frontend`    — `frontend` metrics `available` must be `true`
- `logs`        — `logs/patterns` `mode` must not be `unavailable`
- `traces`      — `traces/breakdown` must return `rows`
- `runtime_db`  — `runtime.dbPool` present **and** every pool has `idle <= max`

## The service matrix

Built into the script (`default_matrix`), one row per service, tab-separated:

```
namespace <TAB> service <TAB> label <TAB> flags
```

`flags` is a comma list from `issues,frontend,logs,traces,runtime_db`. Use `_`
as the namespace for services with an empty namespace (webjs frontends).

To extend or replace, write your own TSV and pass `MATRIX_FILE=...`. Pick
services that exercise a data shape not already covered — a new SDK/language, a
different db engine, a chatty error producer, etc. Confirm a candidate exists
first:

```bash
curl -s -u admin:admin \
  'http://localhost:3000/api/plugins/nais-apm-app/resources/services' \
  | python3 -c 'import sys,json;[print(s["namespace"],s["name"],s.get("sdkLanguage")) for s in json.load(sys.stdin) if s["name"]=="YOURSVC"]'
```

The default matrix intentionally spans: Node SSR, JVM (Ktor/Spring), plain-text
loggers, mongodb / oracle-UCP / postgres-hikari db apps, a chatty error app, a
webjs frontend, and random picks for unbiased coverage.

## Manual spot-checks (not automated)

Some conformance questions require cross-checking the endpoint against the raw
datasource — the harness cannot judge these because it has no independent
source of truth. Do these by hand when a value looks wrong.

Direct datasource queries go through Grafana's proxy:

```bash
# Mimir (PromQL instant)
curl -s -u admin:admin --data-urlencode 'query=<PROMQL>' \
  http://localhost:3000/api/datasources/proxy/uid/nav-metrics/api/v1/query

# Loki (LogQL instant)
curl -s -u admin:admin --data-urlencode 'query=<LOGQL>' --data-urlencode 'limit=5' \
  http://localhost:3000/api/datasources/proxy/uid/nav-logs/loki/api/v1/query

# Loki pattern ingester
curl -s -u admin:admin -G --data-urlencode 'query={service_name="SVC"}' \
  --data-urlencode 'start=<ns>' --data-urlencode 'end=<ns>' \
  http://localhost:3000/api/datasources/proxy/uid/nav-logs/loki/api/v1/patterns

# Tempo TraceQL metrics (what breakdown *should* use)
curl -s -u admin:admin -X POST http://localhost:3000/api/ds/query \
  -H 'Content-Type: application/json' -d '{"from":"<ms>","to":"<ms>","queries":[
   {"refId":"A","datasource":{"uid":"dev-gcp-tempo","type":"tempo"},
    "queryType":"traceql","query":"{resource.service.name=\"SVC\"} | rate() by (name)","step":"30s"}]}'
```

Spot-checks worth repeating:

1. **Scorecard verdicts** — for a service, pull `/scorecard` and independently
   reproduce each of the six checks:
   - `spanMetrics`  → `count(traces_spanmetrics_calls_total{service_name="SVC"})`
   - `runtimeMetrics` → `count({app="SVC", __name__=~"jvm_.*|nodejs_.*|hikaricp_.*"})`
   - `browserTelemetry` → `count({app_name="SVC", job="alloy-faro"})`
   - `logs` → Loki `/loki/api/v1/index/stats?query={service_name="SVC"}`
   - `traces` → Tempo `/api/search?q={resource.service.name="SVC"}`
   - `alertRules` → ruler/grafana rules mentioning the service
   The endpoint's `ok` must match whether the query returns data.

2. **Jobs streak** — pick a `status:failing` cronjob from `/jobs`, then query
   KSM `kube_job_status_failed{namespace="NS", job_name=~"NAME.*"}` /
   `kube_job_status_succeeded` / `kube_job_status_start_time`. Sort child jobs
   newest-first; the streak is the count of consecutive newest failures until
   the first success.

3. **Pattern `isNew`** — `isNew` compares the current window against the
   immediately preceding equal-length window via the Loki pattern ingester.
   The ingester's retention is short; if the preceding window predates it, the
   comparison set is empty and everything is flagged `isNew:true`. Verify by
   querying the pattern ingester for `[from-span, from)` directly — an empty
   result means `isNew` is unreliable for that range (see finding P-1).

4. **DB pool aggregation** — for a multi-pod service sharing one pool name,
   compare `/runtime` `dbPool` against per-pod `hikaricp_connections_{active,
   idle,max}`. `active`/`idle` are summed across pods but `max` is not, so
   `idle` can exceed `max` (see finding R-1).

5. **Trace breakdown mode** — `/traces/breakdown` should return `mode:"traceql"`
   when Tempo TraceQL metrics work. Confirm Tempo metrics work with the direct
   `/api/ds/query` call above; if the endpoint still returns
   `mode:"spanmetrics"` the detection path is failing (see finding T-1).

6. **Facet reconciliation** — faceted issue counts are browser-only and use a
   different grouping than the unfaceted total, so they are *not* expected to
   match exactly. The facet-value sums should be roughly the same order as the
   browser-issue count sum (observed ~1% apart), not wildly off.
