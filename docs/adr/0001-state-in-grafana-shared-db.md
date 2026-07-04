# ADR-0001: Plugin state lives in Grafana's shared database (annotations), not a plugin-owned store

- **Status:** Accepted (2026-07-04)
- **Deciders:** Hans Kristian Flaatten (platform), implementation review 2026-07-04
- **Related:** docs/triage.md (mechanics), #57 (PRD), docs/roadmap.md standing risks

## Context

The plugin runs on HA Grafana (multiple replicas, shared Postgres). It needs
durable state for issue triage (resolve/ignore/assign), per-user mutes, and
settings — but "no operating stateful services for the plugin" is a declared
non-goal. Grafana's shared DB is already operated for Grafana itself on nais
with very little overhead.

## Decision

All plugin state piggybacks on Grafana-owned storage, accessed only through
stable Grafana APIs:

- **Triage** — an append-only event log written as org annotations
  (`nais-apm:triage` + `app:<team>/<app>` + `fp:<fingerprint>` tags), current
  state derived by a newest-event-wins fold at read time. No mutable rows, no
  locks, no leader: concurrent replicas/users append and the fold converges.
- **Per-user mutes** — Grafana plugin user storage (isolated behind
  `src/utils/userStorage.ts` because the API is `@alpha`).
- **Settings** — jsonData/secureJsonData; future shared curation (#68 P1)
  uses jsonData with version/409 optimistic concurrency.
- Everything else is computed at query time (fingerprints are a pure
  function) or lives in the URL. In-memory caches are per-replica,
  short-TTL, performance-only.

## Audit summary (2026-07-04)

**Performance:** the load profile is asymmetric — human-paced writes,
tag-filtered per-service reads. Fine at NAV scale (hundreds of services,
thousands of triage events/year). Three watch items, in expected order:

1. **Shared-table contention** — the annotation table also holds dashboard
   annotations etc.; our reads can degrade from volume we don't control.
   Precedent: Grafana moved alert state history OUT of annotations for scale.
2. **Fetch-limit correctness cliff** — reads are capped; a service whose
   event history exceeds the limit folds from a truncated window and can
   report the WRONG status. First mitigation is code, not storage: fold
   newest-first and stop once status+assignee resolve.
3. **Retention config** — Grafana annotation cleanup silently deletes triage
   history; the backend warns at startup, docs/triage.md documents it.

**Maintenance:** the annotations HTTP API is the most stable Grafana surface
the plugin touches (stable across majors). Riskier couplings are elsewhere
(alert `defaults=` prefill is an internal contract; user storage is alpha).

## Revisit triggers (any one fires a re-decision)

1. Per-service event counts approaching the fetch limit *after* the
   newest-first fold optimization is in place.
2. A feature needing queries annotations cannot express: cross-service
   assignee views, comments/threads, paginated history, audit exports.
3. Measured degradation of tag-filtered read latency (baseline measurements
   from the 2026-07 synthetic-load audit; see appendix when added).
4. Grafana deprecating or materially changing the annotations API.

## Escalation ladder when a trigger fires

1. **grafana-app-sdk unified storage** — if GA for external plugins by then:
   Grafana-operated, fits the entity model, swaps in behind the existing
   `TriageStore` interface.
2. **Plugin-owned Postgres on nais** — the platform already absorbs most
   Postgres toil (Grafana's own DB runs this way), so the cost is schema
   ownership, migrations and a credential surface — real but modest. This is
   the endpoint if unified storage hasn't shipped or doesn't fit.

**Rejected: Loki as the event log.** Append-only fits, but log retention is
30–90 days and triage history must live for years; a dedicated long-retention
stream was judged not worth pursuing (decision: Hans, 2026-07-04).

The design that keeps any migration cheap: triage is an append-only event log
behind the narrow `TriageStore` interface — a backend swap replays the same
events into the same fold. State is never migrated, only events copied.
