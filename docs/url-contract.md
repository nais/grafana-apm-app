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

| Param | Values | Meaning |
|---|---|---|
| `tab` | `overview` \| `server` \| `frontend` \| `runtime` \| `dependencies` \| `traces` \| `logs` | Active tab on the service detail page |
| `environment` | cluster name (e.g. `prod-gcp`) | Environment filter, matches the `k8s_cluster_name` label (or the configured override) |
| `from`, `to` | Grafana time expressions (`now-1h`, unix ms) | Shared time range (`src/utils/timeRange.ts`) |

## Exception drawer (Frontend tab)

The ExceptionDrawer opens purely from URL state — this is the deep-link target
for alert notifications (#65) and shared investigations:

```
/a/nais-apm-app/services/{namespace}/{service}?tab=frontend&environment={env}&exceptionHash={hash}[&exceptionSessionId={id}]
```

| Param | Meaning |
|---|---|
| `exceptionHash` | Exception group identity (today: the Faro/Alloy `hash` field in Loki). Opens the drawer. When #62 lands, an `issueId` fingerprint parameter will supersede this — `exceptionHash` must keep resolving as an alias. |
| `exceptionSessionId` | Selected session inside the drawer (optional). Never meaningful without `exceptionHash`. |

Rules for maintainers:

- Update both params in **one** `setSearchParams` transaction via
  `useUrlParams()` — see AGENTS.md ("URL search params").
- In Grafana alert-rule annotations, templated links use
  `…&exceptionHash={{ $labels.hash }}`.
