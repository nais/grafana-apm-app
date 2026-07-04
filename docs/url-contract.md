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

## Shared query parameters

| Param         | Values                                                                                                | Meaning                                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tab`         | `overview` \| `issues` \| `server` \| `frontend` \| `runtime` \| `dependencies` \| `traces` \| `logs` | Active tab on the service detail page. `server` renders the tab labeled "Endpoints" in the UI (#69 P7: label-only rename, the URL value never changed) |
| `environment` | cluster name (e.g. `prod-gcp`)                                                                        | Environment filter, matches the `k8s_cluster_name` label (or the configured override)                                                                  |
| `from`, `to`  | Grafana time expressions (`now-1h`, unix ms)                                                          | Shared time range (`src/utils/timeRange.ts`)                                                                                                           |

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
