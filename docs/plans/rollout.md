# Nais APM rollout plan

Tracking epic: **#89**. This is the checklist behind it.

**Framing.** The build is essentially done — the plugin already reads real
prod data (Loki/Tempo/Mimir). What remains is **land → deploy → pilot →
widen**, which is mostly deploy + coordination, not code.

**Key insight — server-side needs no SDK.** Most nais apps are already
auto-instrumented, so the plugin delivers Overview / Backend / Database /
Traces / Logs / Issues to them the moment it is deployed, with zero developer
action. The `@nais/apm` SDK is only for **browser/frontend** telemetry — so the
rollout is *not* gated on SDK adoption. Start on the server-side story; layer
the SDK in for frontend teams.

## Phase 0 — Land the code (unblocks everything)

- [ ] **Merge #71** — the M0–M6 PR is currently a **draft**; mark ready →
      review → merge (115 commits → `main`). *Critical path.*
- [ ] **Cut SDK 0.1.0** — merge the release-please Release PR (now correctly
      proposing 0.1.0) → publishes to GHPR.
- [ ] **Merge the `helm-charts` branches** in capability-detection-coupled
      order: `nais-apm-foundations` first, then the pipeline-gap branches
      (source maps, exception normalization, spanmetrics dims, replay ingest
      gate). See #85, #83.
- [ ] **Publish docs** — merge `nais-apm-docs` (already tenant-gated to nav via
      `conditional: [tenant, nav]`).

## Phase 1 — Deploy & verify the data path

- [ ] **#87** — deploy the plugin to the nav-tenant Grafana instance(s).
- [ ] **#85** — deploy the platform pipeline gaps so data flows at full
      fidelity (readable frontend stacks via `cdn.nav.no` source maps, log
      patterns, RED-per-operation, exception normalization).
- [ ] Keep the plugin's fallbacks until the gaps land — they are load-bearing
      (**#83**, `docs/plans/capability-detection-rollout.md`).
- [ ] Smoke-test real services across every tab on tenant data.

## Phase 2 — Pilot with design partners

- [ ] **#88** — onboard the **14 Faro+Sentry dual-stack teams**
      (`docs/navikt-faro-sentry-audit.md`): highest value, sharpest feedback.
      Server-side is automatic; frontend teams add `@nais/apm`.
- [ ] Feedback channel + issue capture; iterate before widening.

## Phase 3 — Widen + close adoption-friction gaps

- [ ] **#81** — publish `@nais/apm` to **npmjs.org** (drop the GHPR
      `read:packages` PAT tax). *Do this before a wide frontend rollout* — it
      is the single biggest per-developer onboarding friction.
- [ ] **#79** `@nais/apm/react`, **#80** browser tracing — SDK ergonomics.
- [ ] **#82** — replay events-only safe tier (broadly enable-able); DOM /
      wireframe / feedback stay DPO-gated.
- [ ] **#84** — server-issue drawer parity.

## External dependencies / gates (not code)

| Gate | Owner | Tracked |
| ---- | ----- | ------- |
| Personvernombud (DPO) sign-off for replay / snapshots / feedback | DPO process | #82 (ingest gate makes them safe-by-default) |
| Per-team alert folders | platform (ongoing) | #33 / #32 — Alerts tab carries an "under construction" badge |
| Platform / helm deploys | owner + platform | #85, #83 |
| Multi-tenant (non-nav agency onboarding) | demand-driven | #86 — nav-only today |

## Bottom line

You are at a **deploy-and-pilot** stage, not a build stage. Fastest path to
real value: merge #71 → deploy the plugin (#87) → auto-instrumented apps
benefit immediately → pilot the SDK with the 14 dual-stack teams (#88) →
prioritize npmjs (#81) before going wide.
