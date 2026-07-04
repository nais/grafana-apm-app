# Stable URL contract

These URL patterns and query parameters are a **stable API**. Alert
annotations, Slack notifications, runbooks, and shared links depend on them —
treat renames as breaking changes: keep the old parameter resolving as an
alias for at least two minor releases and note the change in the CHANGELOG.

## Service pages

```
/a/nais-apm-app/services                                  service inventory
/a/nais-apm-app/services/{namespace}/{service}            service detail
/a/nais-apm-app/namespaces/{namespace}                    namespace overview
/a/nais-apm-app/dependencies/{name}                       dependency detail
```

## Fleet pages

```
/a/nais-apm-app/service-map                               global service map (#22)
/a/nais-apm-app/jobs                                      cron / Naisjob inventory (#74)
```

Both fleet pages read the global `from`/`to` and `environment` params (below) and
carry their own view/filter params (see "Page-scoped query parameters").

## Shared query parameters

| Param         | Values                                                                                                | Meaning                                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tab`         | `overview` \| `issues` \| `server` \| `frontend` \| `runtime` \| `database` \| `dependencies` \| `traces` \| `logs` \| `profiling` | Active tab on the service detail page. `overview` is the default and is stored by **omitting** the param. `server` renders the tab labeled "Endpoints" in the UI (#69 P7: label-only rename, the URL value never changed). Capability-gated values silently fall back to `overview` when their datasource is absent: `issues`/`logs` need Loki, `traces` needs Tempo, `dependencies` needs service-graph metrics, `database` needs database spans, `profiling` needs Pyroscope. |
| `environment` | cluster name (e.g. `prod-gcp`), comma-separated for multi-select                                       | Environment filter, matches the `k8s_cluster_name` label (or the configured override)                                                                  |
| `from`, `to`  | Grafana time expressions (`now-1h`, `now`, ISO-8601, unix ms)                                          | Global shared time range, owned by the page-header time picker (`HeaderTimeControls`) and read by every tab and fleet page via `src/utils/timeRange.ts`. Relative expressions are stored verbatim; absolute picks/zoom store ISO-8601. Defaults `now-1h`/`now`.          |

## Page-scoped query parameters

These params belong to a single page or tab. They are shareable deep-link state
and follow the same stability promise as the shared params above.

### Service Map (`/service-map`)

| Param         | Values                    | Meaning                                                                                                                                     |
| ------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `view`        | `namespaces` \| `services` | Cluster granularity of the map. When absent/invalid it defaults by fleet size (`namespaces` above ~50 services, otherwise `services`).       |
| `environment` | cluster name              | Same semantics as the shared `environment` param.                                                                                          |

### Jobs (`/jobs`)

| Param       | Values                                                                            | Meaning                                                              |
| ----------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `namespace` | comma-separated namespace list                                                    | Namespace filter (multi-select).                                     |
| `q`         | free text                                                                         | Name search filter.                                                  |
| `status`    | `failing`                                                                         | When set, shows only failing jobs (the only recognized value).       |
| `sort`      | `name` \| `namespace` \| `cluster` \| `schedule` \| `lastRun` \| `nextRun` \| `streak` | Sort column (default `name`).                                        |
| `dir`       | `asc` \| `desc`                                                                    | Sort direction (default `asc`).                                      |

### Issues tab facets (`tab=issues`)

Faceted narrowing of the unified issues list. Setting any facet scopes the list
to browser telemetry (facet fields are Faro logfmt fields). Values are the
free-form facet strings discovered from the backend `facets` response; an empty
or absent value means no filter.

| Param          | Meaning                                              |
| -------------- | ---------------------------------------------------- |
| `issueVersion` | Filter to a single `app_version`.                    |
| `issueBrowser` | Filter to a single `browser_name`.                   |
| `issuePage`    | Filter to a single `page_url`.                       |

### Overview tab SLO (`tab=overview`)

| Param | Values                              | Meaning                                                                                          |
| ----- | ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `slo` | `0.99` \| `0.995` \| `0.999` \| `0.9999` | Selected SLO target for the error-budget panel. Any other value falls back to `0.999` (default). |

## Exception drawer (Issues tab + Frontend tab)

The ExceptionDrawer opens purely from URL state — this is the deep-link target
for alert notifications (#65) and shared investigations. `issueId` (and the
legacy `exceptionHash`) resolve identically on **both** `tab=issues` (#69 P1,
the unified triage surface) and `tab=frontend` (the compact browser-scoped
row) via the shared `useExceptionDrawerState` hook
(`src/pages/tabs/frontend/useExceptionDrawer.ts`) — a link built for one tab
still opens the drawer if shared or bookmarked with the other:

```
/a/nais-apm-app/services/{namespace}/{service}?tab=issues&environment={env}&issueId={fingerprint}[&exceptionSessionId={id}]
/a/nais-apm-app/services/{namespace}/{service}?tab=frontend&environment={env}&exceptionHash={hash}[&exceptionSessionId={id}]
```

| Param                | Meaning                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issueId`            | Fingerprint-based issue identity (#62), e.g. `v1:9f2ab31c04d7e655`. The primary drawer key: resolved to the group's member hashes via `/exceptions/groups`.                         |
| `exceptionHash`      | Legacy identity: a single Faro/Alloy `hash`. Still resolves (opens the drawer scoped to that one hash) — keep supporting it forever; old alert annotations and shared links use it. |
| `exceptionSessionId` | Selected session inside the drawer (optional). Never meaningful without `issueId`/`exceptionHash`.                                                                                  |

Rules for maintainers:

- Update both params in **one** `setSearchParams` transaction via
  `useUrlParams()` — see AGENTS.md ("URL search params").
- `tab=frontend&issueId=…` and legacy `exceptionHash` links keep resolving
  forever — they predate the Issues tab and ship in alert annotations.
- Alert-template deep links (`pkg/plugin/alerttemplates.go`) point
  issue-related annotations (`exception-spike`, `new-exceptions`) at
  `tab=issues`; the `web-vitals` template still points at `tab=frontend`
  (a UX-health alert, not an issue).
