# infra/

Platform infrastructure recommendations for the Nais APM error-tracking
roadmap (see `docs/roadmap.md` at the repo root). **Everything under this
directory is a deliverable for the NAIS platform team to apply in their own
repos** — nothing here is consumed by `grafana-otel-plugin` itself, and
nothing here should be wired into this repo's build/CI. Each file states
its own target location; this README is the index.

Source material: `gh issue view 60/64/59/58` in `nais/grafana-apm-app`
(researched PRDs) and `docs/roadmap.md`'s M0 platform track.

## Index

| Artifact | Source issue | Milestone | Target location |
|---|---|---|---|
| ~~`alloy/faro-receiver-sourcemaps.alloy`~~ | #60 Phase 0 | M0 (v0.14) | **APPLIED** to `helm-charts/features/alloy-faro/templates/config.yaml` (download_timeout 4s + location escape hatch; cdn.nav.no allowlist was already live) |
| `docs/source-maps-on-nais.md` | #60 Phase 0 | M0 (v0.14) | nais docs (docs.nais.io), linked from the plugin's Frontend tab once Phase 2 ships |
| `docs/meta-tag-contract.md` | #59 (proposal), referenced by #60 Phase 1 | M1 (v0.15) | New nais platform issue (HTML-serving/ingress component); nais docs once implemented |
| `actions/apm-deploy-annotation/action.yml` + `actions/README.md` | #64 Phase 0 | M2 (v0.16) | New GitHub Action repo, `nais/apm-deploy-annotation`, published as `@v1` |
| ~~`alloy/faro-replay-stream.alloy`~~ | #58 Phase 1 (pipeline) | M5 (v0.19) — **FUTURE, do not apply yet** | Moved to `helm-charts/features/alloy-faro/docs/faro-replay-stream.alloy.future`, next to the live config it will one day join |

## What ties these together

The roadmap's dependency spine sequences the error-tracking chain — #60
(source maps) unblocks #62 (owned fingerprinting) unblocks #57 (triage);
#59 (`@nais/apm`) unblocks #66 (console stacks) and #58 (replay). The
platform-track artifacts here are the non-plugin-code half of that chain:

1. **Source maps (#60)** — Alloy needs to fetch maps from somewhere it can
   actually reach (Wonderwall blocks it from app origins), and teams need a
   written contract for how to publish those maps correctly. The `.alloy`
   config and the guideline doc ship together; the guideline doc explicitly
   cross-references the Alloy config's cache-timing behavior (the
   upload-before-deploy trap only makes sense once you understand
   `error_cleanup_interval`).
2. **Meta-tag contract (#59)** — `@nais/apm`'s zero-config `init()` needs a
   platform-provided way to learn `app.name`/`environment`/`version`/
   collector URL. This is filed as a proposal, not an implemented feature —
   the SDK's build-time-env fallback (documented in the same file) is what
   actually ships until a platform team picks this up.
3. **Deploy annotations (#64)** — nais already knows every deployment; the
   composite Action is the cheapest possible bridge from "nais deployed
   this" to "Grafana has an annotation the plugin can query", without any
   new stateful service. It's deliberately Phase 0 only: no nais GraphQL
   API polling, no regression semantics — those are plugin-side follow-ups
   gated on #57.
4. **Replay stream (#58)** — included for completeness and to get the
   retention/labeling design written down early, but explicitly marked
   FUTURE. It should not be applied until the SDK-side recording code
   exists and the Phase 0 spike (a throwaway pilot, not this config) has
   validated real payload sizes.

## Platform dependencies (facts + asks that emerged during implementation)

Milestones M6–M7 shipped features that key on platform-side capabilities.
These are the platform facts to keep true and the one open ask, discovered
while building the plugin — not part of the original #57–#64 artifact set
above, but the platform team owns them.

- **Loki pattern ingester — keep enabled (dependency, not an ask).** The log
  patterns feature (LogsTab *Patterns* view + "new error patterns" card) calls
  Loki's `/loki/api/v1/patterns` pattern-ingester endpoint
  (`pkg/plugin/patterns.go`). It is **already enabled in production** — this is
  a documented keep-enabled dependency, not a new request. If it is ever
  disabled the feature silently degrades to a client-side log-sampling fallback
  (coarser, slower); nothing else breaks.
- **kube-state-metrics families exposed to tenant Grafana (Jobs/CronJob
  view).** The #74 Jobs view (`pkg/plugin/jobs.go`) reads these KSM families
  from the metrics datasource: `kube_cronjob_info`,
  `kube_cronjob_status_last_schedule_time`, `kube_cronjob_next_schedule_time`,
  `kube_job_owner`, `kube_job_status_succeeded`, `kube_job_status_failed`,
  `kube_job_status_start_time`, `kube_job_status_completion_time`. These must be
  scraped and readable by tenant Grafana or the view renders an empty state
  (the plugin surfaces an explanatory note when the `kube_*` job families are
  absent).
- **Pyroscope — the remaining open platform decision.** The Profiling tab ships
  **gated**: it is hidden until a Pyroscope datasource is detected
  (`src/pages/tabs/ProfilingTab.tsx`, `pkg/plugin/capabilities.go`). Nothing
  ships broken, but the tab stays dark until the platform decides to run
  Pyroscope. This is the one genuine platform *ask* in this list.
- **Grafana annotation retention — must stay keep-forever for triage.** Issue
  triage state, deploy markers, and regression detection all live as Grafana
  **org annotations** (see [ADR-0001](../docs/adr/0001-state-in-grafana-shared-db.md)).
  The `[annotations.api]` retention (`max_age`) must stay at keep-all/unlimited
  or triage history and deploy/regression markers silently truncate. The plugin
  runs a startup health check that warns when retention is finite, but it cannot
  change the setting — that is a platform config guarantee.
- **`@nais/apm` GHPR read-token for consumers.** `@nais/apm` is published to the
  **GitHub Package Registry**, not npmjs.org. GHPR requires an authenticated
  request to resolve *any* package under a scope — so even though the package is
  public, consuming apps' CI (and developer machines) need a GitHub token with
  the **`read:packages`** scope for the `nais` org configured in `.npmrc`. See
  `apm-client/README.md` for the setup; a future move to npmjs.org would remove
  this friction.

## Judgment calls made while writing these files (flag for platform review)

- **#58's `loki.process` stage syntax is a design sketch, not a verbatim
  doc quote.** Issue #60 quotes the `faro.receiver` sourcemaps block
  directly from Alloy's docs/source, so that file's syntax is exact. Issue
  #58 only describes the replay relabeling in prose ("a loki.process stage
  matches event_name=faro.session_recording.* and rewrites the stream
  label to kind=replay") without quoting the concrete `stage.*` block
  syntax. I wrote a plausible `stage.match` + `stage.static_labels` block
  and flagged inline that it needs verification against the current Alloy
  `loki.process` reference before anyone applies it — this is also why the
  whole file is marked FUTURE/do-not-apply regardless.
- **Deploy annotation JSON is built with `jq` instead of hand-interpolated
  into a string**, unlike issue #64's literal curl example. Same payload
  shape and same field values, just safely escaped since `service`/
  `namespace`/`environment` are action inputs (arbitrary team-supplied
  strings) rather than the issue's hardcoded example values. Flagging in
  case the platform team specifically wants the bare `-d "{...}"` form for
  auditability/simplicity — trivial to revert.
- **Meta-tag contract's injection mechanism is left as an open decision**
  (platform HTML rewriting vs. extending the experimental
  `frontend.generatedConfig`), because #59 itself leaves it open ("Is
  platform buy-in secured?"). I did not pick one — the doc presents both
  with the SSR caveat, matching the issue's own stated uncertainty rather
  than inventing a resolution.
- **cdn.nav.no `<team>/<app>/` path segments** in the source-maps doc and
  Alloy config use `<team>`/`<app>`/`<release>` placeholders consistently
  with #60's own examples (which mix `team-x`/`app-y` in the Alloy sketch
  and `<team>`/`<app>` in the non-public opt-out). No contradiction, just
  normalized to angle-bracket placeholders throughout for consistency.
