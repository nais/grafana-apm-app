# PRD: Unified alerting

Status: draft for review · Owner: Nais observability · Last updated: 2026-10-21

Teams on Nais can write alerts in two ways today: `PrometheusRule` resources
evaluated by the Mimir ruler, and rules created by hand in Grafana. The two
paths deliver through different Alertmanagers and show up in different places,
and nobody owns the configuration that connects them. The result is alerts
that never arrive, alerts that never stop, and team alert receivers where most
notifications fail.

This PRD sets one owner for Grafana alerting configuration (nais
api-reconcilers), one alert view shared by Console and Nais APM, and a
migration that gets teams off the legacy setup without breaking anyone
silently.

## Problem, with evidence

Numbers come from production Mimir and Loki on 2026-10-21. The queries are in
the appendix.

1. **Alerts that cannot route.** 592 of 2,857 alert rules in the `tenant`
   ruler have no `namespace` label (teameresept 280, teamfrikort 129,
   team-oebs 58). The team route in
   `helm-charts/features/monitoring/templates/team-alerts.yaml:95` matches on
   `namespace`, so these rules fall through to the `null` receiver. The teams
   believe they are covered, and they are not.
2. **Severity is free text.** Live `severity` values: warning 1,222, critical
   1,073, danger 401, info 28, error 23, high 20, warn 5, medium 2, low 2, missing 81. About
   450 rules fall outside `critical|warning|info`. Inhibition does not apply to
   them, and Slack shows them as `:question:`.
3. **Alerts that never stop.** 26 alertname/namespace pairs fired more than
   90% of the last 30 days. 402 pairs fired at least once. A few teams produce
   most of it: `Teamfrikort - inaktiv jobb` alone averaged 46 concurrently
   firing series. Alerts that always fire train people to ignore the channel.
4. **Notifications that fail.** In 30 days the tenant Alertmanagers tried
   about 649,000 notifications and about 529,000 failed (81%):
   - Slack: 250,973 tried, 153,001 failed. In a 6-hour Loki sample from `dev`,
     94% of Slack failures came from one team's custom `AlertmanagerConfig`
     posting to a deleted channel (`404: channel_not_found`).
   - Webhook: 398,153 tried, 376,504 failed, all `clientError`, in `dev` and
     `dev-fss`. Example: a team webhook receiver posting to an endpoint that
     returns a 404 page.
   Nobody is told when a receiver fails.
5. **Two configuration owners, neither authoritative.** The Grafana reconciler
   in api-reconcilers creates contact points and policy routes, but:
   - It never deletes contact points. `cleanupAlerting`
     (`reconciler.go:834`) only edits the policy tree.
   - Each team reconcile does GET → modify → PUT on the whole policy tree
     (`reconciler.go:674`). The reconciler runs 10 workers and locks only per
     team, so parallel reconciles of different teams lose each other's routes.
   - It writes the policy tree with `X-Disable-Provenance: true`, so anyone
     with UI access can change it. `cleanupAlerting` writes the tree *without*
     that header, which marks it as API-provisioned. Grafana rejects changing
     provenance back, so after the first team deletion later updates may fail.
     Contact points and templates are already locked against UI edits.
   - Routes match labels `team` and `env` (`reconciler.go:762`). Grafana rules
     only have these if the author adds them by hand. Rules created from Nais
     APM templates set `namespace` and `service` instead
     (`pkg/plugin/alerttemplates.go:804`), so they match no team route.
   - Folders are not reconciled at all. A Grafana rule is owned by whatever
     folder somebody put it in. Every user has the Editor role
     (`grafana/values.yaml:199`) and can create folders anywhere.
6. **Two views that disagree.** Console (`/team/<team>/alerts`) shows Mimir
   ruler rules only, team-scoped and read-only, with no app view. Nais APM
   shows Mimir and Grafana rules per namespace and per service, but parses the
   ruler group path wrong. All 837 live groups are named
   `<cluster>//<namespace>/<rule>/<uuid>` (double slash).
   `extractNamespaceFromGroupFile` (`pkg/plugin/alerts.go:369`) returns an
   empty string for that shape, so Nais APM misses rules that lack a
   `namespace` label. nais api already handles the shape.
7. **Silences live in the wrong place.** Slack "Silence" buttons for team
   alerts open the per-cluster tenant Alertmanager. Its silences are stored on
   a 1Gi volume on GCP and on pod disk elsewhere, so they are lost on cluster
   rebuild (everywhere) and on pod restart (on-prem). Grafana rules have a
   third set of silences in Grafana's Alertmanager. Neither Console nor Nais
   APM can show or create silences.

## Goals

- G1. api-reconcilers is the single authoritative source for Grafana teams,
  team folders, contact points and notification policies. Drift in the
  objects it owns is corrected on the next reconcile.
- G2. Every alert rule a team owns is visible in both Console and Nais APM
  with the same state, whether it lives in a `PrometheusRule` or in Grafana.
- G3. Teams can create, see, silence and clean up alerts from Nais APM, scoped
  to their own team.
- G4. The owning team can see failed deliveries and chronically firing alerts.
- G5. Existing teams migrate on a published timeline. No alert stops
  delivering, and no blackholed alert starts posting, until the team has been
  told which rule and when.

## Non-goals

- A new Nais alert CRD. `nais.io/v1 Alert` and alerterator were removed in
  2023. `PrometheusRule` is the declarative format.
- Two-way sync between git-managed `PrometheusRule` and the Grafana UI. A rule
  is managed in git or in Grafana, never both.
- Paging and on-call (PagerDuty, Opsgenie). Slack stays the delivery channel.
- Per-team Mimir tenants. All teams share the `tenant` org.
- Platform (`nais` tenant) alerts. They keep their own routing.
- Deleting Grafana folders that hold dashboards.

## Current state

```
PrometheusRule (team ns)                       Grafana UI (any folder)
  │ Alloy mimir.rules.kubernetes                 │
  ▼                                              ▼
Mimir ruler (tenant)                          Grafana ruler (HA, single-node eval)
  │                                              │
  ▼                                              ▼
Mimir Alertmanager (tenant)                   Grafana Alertmanager
  │ forwardConfig, k8s_cluster_name              │ policy tree: team=, env=
  ▼                                              ▼
mimir-alert-proxy-<cluster>                   contact point team-<slug>-<env>
  │ Alertmanager v2 API                          │ shared Slack webhook + recipient
  ▼                                              ▼
tenant-alertmanager (per cluster)                Slack
  │ AlertmanagerConfig slack-config
  │ (replicated per namespace, matches namespace=)
  │ + custom team AlertmanagerConfig
  ▼
Slack / webhooks
```

- Rule source of truth: `PrometheusRule` in team namespaces, or Grafana rules
  in folders that nobody manages. Datasources set `manageAlerts: false`.
- Channel source of truth: `TeamEnvironment.slackAlertsChannel`, set in
  Console. It fans out to the namespace annotation
  `replicator.nais.io/slackAlertsChannel` (Mimir path) and to Grafana contact
  points (Grafana path, behind `FEATURE_ENABLE_GRAFANA_ALERTS`).
- The proxy and the per-cluster Alertmanagers exist because Alloy's
  `mimir.alerts.kubernetes` writes one config document per tenant, so clusters
  overwrite each other (grafana/alloy#5441, still open).
- Grafana runs community chart 13.2.7 (Grafana 13.2.2) with unified alerting
  in HA mode. The plugin backend calls Grafana with a service account token,
  not as the user.
- nais api exposes Mimir ruler rules as `PrometheusAlert`, marked
  experimental. It has no Grafana client and no alert mutations. Reads are
  open to any authenticated user, like every other read in the API.

## Design principles

1. **One writer per object.** If api-reconcilers owns an object, the UI cannot
   edit it (provenance on), and drift is corrected on the next reconcile.
2. **Same routing key for both sources.** Alerts route on `namespace=<team>`
   whether they come from Mimir or Grafana. The Grafana folder decides who may
   edit a rule and is the fallback when `namespace` is missing.
3. **Console and Nais APM read the same API.** Merge logic lives in nais api
   and is not duplicated in each client.
4. **Tell before you change delivery.** Any change that makes an alert start
   or stop arriving gets a per-team notice that names the rule and the date.
5. **Disable, don't delete.** Cleanup pauses rules and disables receivers.
   Deletion comes later and only after a final notice.

## Requirements

### R1. Reconciler owns Grafana alerting configuration (api-reconcilers)

- R1.1 **Team folders.** For each team, create a top-level folder with UID
  `team-<slug>` and title `<slug>`. Grant the Grafana team Edit and remove the
  org-wide Viewer and Editor grants on that folder. Folder Edit includes rename
  and delete, and Grafana OSS has no custom roles to prevent that, so the
  reconciler:
  - restores the title if it changes;
  - recreates the folder if it is deleted;
  - reports subfolders, because `grafana_folder` holds the immediate folder's
    title, not the path;
  - reports other folders titled `<slug>`, because titles are unique only
    among siblings.
  Each correction is counted (R1.7) and shown to the team (R3.5).
- R1.2 **Contact points: full diff.** Compute the desired set
  (`team-<slug>-<env>` for each environment with a channel). Delete every
  `team-*` contact point that is not in it, including when a team is deleted.
- R1.3 **Policy tree: one writer, whole tree.** A single goroutine owns the
  team section of the tree and rebuilds it from all teams in one pass. Team
  reconciles mark the tree dirty instead of writing it. Remove the per-team
  write path. For each team:
  - a route matching `namespace="<slug>"`, then a route matching
    `grafana_folder="<slug>"` for rules without `namespace`;
  - under each, a child route per environment matching `env="<env>"`, and a
    team default receiver for rules without `env` (open decision 2);
  - during migration, the old `team=`/`env=` matchers as an extra route, so
    nothing that routes today stops routing.
  Write with provenance on. Fix `cleanupAlerting` to use the same writer.
- R1.4 **Concurrency.** The single writer (R1.3) removes the cross-team race.
  Use the `notifications.alerting.grafana.app` routing tree API with
  `resourceVersion` if our build serves it, so writes from elsewhere are
  detected and not overwritten. The legacy `PUT /api/v1/provisioning/policies`
  has no optimistic locking.
- R1.5 **Prune unmanaged alerting objects.** After the migration deadline
  (R6), delete contact points and routes that the reconciler does not own,
  except an explicit allowlist for platform objects. Before the deadline,
  report them only. Folders are never deleted by the reconciler; empty legacy
  folders are listed for manual removal.
- R1.6 **Slack authentication.** Move contact points from one shared incoming
  webhook with a `recipient` override to a Slack bot token that posts by
  channel ID. Slack-app incoming webhooks ignore the channel override. Scopes:
  `chat:write`, `chat:write.public`, `channels:read`, `groups:read`. Private
  channels still need the bot invited (`/invite`); Console says so (R5.2).
- R1.7 **Metrics.** Export drift corrections, pruned objects and write
  failures per object kind.

### R2. One alert API (nais api)

- R2.1 Add Grafana-managed rules to the `Alert` interface as `GrafanaAlert`,
  read from Grafana's Prometheus-compatible rules endpoint. A rule belongs to
  a team when its folder is `team-<slug>` or its `namespace` label is the team
  slug. Remove the `EXPERIMENTAL` marker once both sources ship.
- R2.2 Every alert carries:
  - team and environment;
  - source (`PROMETHEUS_RULE` or `GRAFANA`) and who manages it (`GIT` or
    `GRAFANA`);
  - state, active instances, labels and annotations;
  - an edit link (Grafana rule UID, or the manifest);
  - `application` when the rule can be tied to one (R4).
- R2.3 Add `Application.alerts` and `Job.alerts` so Console can show alerts on
  workload pages.
- R2.4 **Silences, per source.** `TeamEnvironment.silences`,
  `createAlertSilence` and `expireAlertSilence`:
  - `PROMETHEUS_RULE` alerts are silenced in the tenant Alertmanager for that
    environment's cluster (Mimir Alertmanager after R7), with a forced
    `namespace="<team>"` matcher.
  - `GRAFANA` alerts are silenced in Grafana's Alertmanager, with a forced
    `grafana_folder="<slug>"` or `namespace="<team>"` matcher.
  Mutations require team membership, and every write goes to the activity log.
- R2.5 Delivery health per team environment: the last successful and the last
  failed delivery, with the failure reason. For the Mimir path the reason
  comes from Alertmanager metrics (the `reason` label) and logs. For the
  Grafana path it comes from logs only, because
  `grafana_alerting_notifications_failed_total` has no reason label.
- R2.6 Reads stay open to authenticated users, consistent with the rest of the
  API. All new mutations are team-scoped.

### R3. Nais APM: manage alerts

- R3.1 Fix `extractNamespaceFromGroupFile` for the
  `<cluster>//<namespace>/…` shape now. Move to the nais api alerts once R2.1
  ships, and drop the plugin's own Mimir and Grafana fan-out.
- R3.2a Templates set `namespace`, `service`, `env` and `source=nais-apm`, so
  rules created today route through the existing `team`/`env` and future
  `namespace` routes. Add the `team` label until R1.3 ships.
- R3.2b Create Grafana rules through the provisioning API
  (`POST /api/v1/provisioning/alert-rules`) in the team folder, with
  `X-Disable-Provenance: true` so they stay editable in Grafana. This replaces
  the `/alerting/new?defaults=` prefill and removes the dependency on Grafana's
  internal `RuleFormValues` (#77). The plugin backend writes with a service
  account, so it checks the caller's team membership through nais api before
  every write.
- R3.3 Rules managed in git are read-only in Nais APM, with a link to the
  manifest. Rules managed in Grafana can be edited, paused and deleted, and can
  be exported as `PrometheusRule` YAML for teams that want them in git.
- R3.4 Silence a firing alert from the drawer, through R2.4.
- R3.5 A "needs attention" list per team:
  - rules missing `namespace` or with a non-standard `severity`;
  - rules that have fired for more than 7 days, and flapping rules;
  - rules outside the team folder, and folder drift (R1.1);
  - failing delivery (R2.5).

### R4. Label contract

| Label | Required | Set by | Used for |
|---|---|---|---|
| `namespace` | yes | rule author or template | team routing, ownership |
| `severity` | yes: `critical`, `warning`, `info` | rule author | inhibition, Slack formatting |
| `k8s_cluster_name` | yes, Mimir | Alloy | environment routing |
| `grafana_folder` | automatic, Grafana | Grafana | ownership, fallback routing |
| `env` | Grafana only, optional | rule author or template | environment child route |
| `app` | recommended | rule author or template | app scoping in Console and Nais APM |
| `source` | optional | template | shows where the rule came from |
| `alert_type=custom` | optional | rule author | opt out of the default team route |

Admission (Kyverno) warns, without rejecting, when a `PrometheusRule` lacks
`namespace` or uses a non-standard `severity`. Two defaults are tempting:
setting `namespace` from the resource namespace, and mapping `danger` and
`error` to `critical`. The first would make 592 silent rules start posting;
the second changes the formatting and inhibition of about 450 rules. Both ship
only per team after notice (R6, open decision 3).

A team can set `namespace` to another team's slug on any rule, from either
source, and spam that team's channel. That is true today for Mimir rules. We
accept the risk and make it visible: R3.5 lists rules that route to a team but
live outside its namespace or folder.

### R5. Delivery health

- R5.1 Detect when a team receiver fails repeatedly with a client error
  (`channel_not_found`, `not_in_channel`, `is_archived`, webhook 4xx) and tell
  the team in their default alerts channel.
- R5.2 Validate `slackAlertsChannel` when it is saved in Console, using the
  bot token. Warn if the channel is private and the bot is not a member.
- R5.3 A custom receiver that has failed every attempt for 14 days after its
  notice is disabled: its route is set to the `null` receiver through a
  platform override. The team can re-enable it after fixing it. Nothing is
  deleted.

### R6. Migration and cleanup

The teams do the work. The platform provides reports, tooling and dates.

1. **Inventory (platform, week 0).** Use an admin token to list:
   - folders, contact points, policy routes and Grafana rules that the
     reconciler does not own;
   - Mimir rules missing `namespace` or with a non-standard `severity`;
   - chronically firing rules;
   - custom `AlertmanagerConfig` with failing receivers.
   Each Grafana rule outside a team folder is assigned an owner, in this order:
   its `namespace` or `team` label, then the team whose members last edited
   it, then the folder's permission holders. Rules with no match go on a
   platform list for manual follow-up.
2. **Notice (week 0).** Post to each affected team's alerts channel and to the
   platform channel, naming each rule, what changes and the date. Show the
   same list in Nais APM (R3.5) and Console.
3. **Team migration (weeks 1–6).** Teams:
   - move Grafana rules into their team folder, or export them to
     `PrometheusRule`;
   - add missing labels and opt in to the `namespace` and `severity` defaults;
   - delete or fix chronic alerts;
   - repair or remove failing custom receivers.
4. **Deadline (week 6).**
   - Unmigrated Grafana rules with an owner are exported, moved to the owner's
     team folder and paused, and the team is told which ones.
   - Unowned contact points and routes are removed (R1.5).
   - Failing custom receivers are disabled (R5.3).
   - Nothing is deleted.
5. **Afterwards.**
   - Remove the legacy `team=`/`env=` routes (R1.3).
   - Delete paused rules left untouched for 90 days, after a final notice.
   - Remove empty legacy folders by hand.

### R7. Delivery path consolidation (later)

Move team alert delivery to Mimir Alertmanager only. That gives silences
stored in GCS, one place for inhibition and no proxy. It needs a single writer
for the `tenant` Alertmanager config: api-reconcilers, or one component in the
management cluster, renders it from team settings and custom configs instead
of Alloy in each cluster. It removes `tenant-alertmanager.yaml`,
`team-alerts.yaml`, `alert-proxy.yaml` and `forwardConfig`.

Platform inhibition rules already include `namespace` in `equal`
(`alloy/values.yaml:117`); they must also add `k8s_cluster_name`. Mimir
Alertmanager needs egress to Slack. Silences for Mimir alerts (R2.4) move from
the per-cluster Alertmanagers to Mimir Alertmanager in the same change.

## Phases

| Phase | Content | Done when |
|---|---|---|
| 0. Fix and measure | R3.1 parser fix; R3.2a template labels; R1.2 contact point delete; `cleanupAlerting` provenance fix; R6.1 inventory | Nais APM shows every ruler rule; APM template rules route; inventory published |
| 1. Authoritative reconciler | Resolve open decisions 1, 2 and 4; R1.1, R1.3, R1.4, R1.6, R1.7; R5.1 | Two parallel team reconciles keep both routes; UI edits to reconciled objects are refused or reverted; failing receivers produce a team notice |
| 2. One alert API | R2.1–R2.3, R2.5, R2.6; Console app tab; R5.2 | Console and Nais APM show the same alerts and delivery health for a team |
| 3. Manage in Nais APM | R3.2b–R3.5, R2.4 silences | A team creates, silences and deletes a Grafana rule without leaving Nais APM |
| 4. Migration | R6.2–R6.5, R1.5 prune, R5.3 | No unowned alerting objects; no rules missing `namespace` |
| 5. Consolidation | R7 | tenant-alertmanagers and proxy removed |

## Success metrics

| Metric | Today | Target |
|---|---|---|
| Notification failure rate in tenant Alertmanagers, all integrations | 81% | below 5% after R5.3 |
| Alert rules missing `namespace` | 592 | 0 |
| Alert rules with non-standard or missing `severity` | 534 | 0 |
| Alertname/namespace pairs firing more than 90% of 30 days | 26 | below 5 |
| Reconciler drift corrections per day | not measured | trending to 0 after the deadline |
| Teams with at least one alert visible in Nais APM | measure in Phase 0 | up after Phase 3 |

## Decisions

Settled:

- api-reconcilers is the authoritative source for Grafana teams, folders,
  contact points and policies (2026-10-21).
- Old folders and alert configuration are cleaned up, and teams migrate their
  own alerts.
- Both rule sources stay. No new CRD and no two-way sync.

Open:

1. **Routing tree API.** Does our Grafana 13.2.2 build serve
   `notifications.alerting.grafana.app` without a feature toggle? Check in the
   management cluster.
2. **Default channel for Grafana rules without `env`.** Pick one channel per
   team (the production environment's?), or require `env` on Grafana rules.
3. **`namespace` and `severity` defaults.** Per team on request, or for
   everyone after the deadline?
4. **Slack bot token.** Who owns the Slack app and token rotation?
5. **Custom `AlertmanagerConfig`.** Keep as a team escape hatch, or replace it
   with extra channels configured in Console?

## Risks

- **Folder edits by team members.** Edit on a folder includes rename and
  delete. A rename breaks fallback routing until the next reconcile. A delete
  removes the team's Grafana rules. Mitigations: primary routing is on
  `namespace` (principle 2), the reconciler recreates the folder, and Nais APM
  creates rules with `namespace` set. Deleted rules cannot be restored by the
  reconciler; Grafana's rule version history (`rule_version_record_limit: 5`)
  is the only record.
- **Turning on blackholed alerts.** Fixing labels makes old, unreviewed rules
  start posting. The order in R6 (notice first, team opts in) exists to
  prevent a wave of spam.
- **Grafana internal APIs.** The provisioning API is stable; the `defaults=`
  prefill is not. R3.2b removes the dependency.
- **Service account writes.** The plugin writes to Grafana as a service
  account, so Grafana's folder permissions do not protect against a plugin
  bug. R3.2b's membership check is the control and needs tests.
- **HA single-node evaluation.** Grafana evaluates every rule on one node.
  Watch evaluation duration as more teams create rules.

## Appendix: evidence queries

Mimir, `X-Scope-OrgID: tenant`, 2026-10-21:

```promql
# notifications and failures, 30d
sum by (integration) (increase(alertmanager_notifications_total[30d]))
sum by (integration, k8s_cluster_name, reason) (increase(alertmanager_notifications_failed_total[30d]))

# chronic firing: share of 5m samples firing over 30d
count(sum by (namespace, alertname) (count_over_time(ALERTS{alertstate="firing"}[30d:5m])) / (30*24*12) > 0.9)
```

Ruler census: `GET /prometheus/api/v1/rules?type=alert`, counting rules by
`labels.namespace`, `labels.severity` and group `file` shape.

Loki, `X-Scope-OrgID: nais`, 6-hour sample:

```logql
{service_namespace="nais-system", k8s_cluster_name="dev"} |= "Notify for alerts failed"
```

Code references: `api-reconcilers/internal/reconcilers/grafana/reconciler.go`,
`helm-charts/features/{alloy,mimir,monitoring,grafana}`,
`api/internal/graph/schema/alerts.graphqls`,
`api/internal/thirdparty/promclient/client.go`,
`console-frontend/src/routes/team/[team]/alerts`, and in this repo
`pkg/plugin/alerts.go` and `pkg/plugin/alerttemplates.go`.
