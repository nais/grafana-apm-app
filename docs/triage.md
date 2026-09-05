# Issue triage

> Storage architecture decision and revisit triggers: [ADR-0001](adr/0001-state-in-grafana-shared-db.md).

Triage state (resolve / ignore / assign, #57) is stored as an **append-only
event log in Grafana organization annotations**. Grafana persists annotations
in its own database — shared across all Grafana replicas in an HA setup — so
triage state is replica-safe with **zero new infrastructure**, and the log
doubles as a full audit history.

## Storage contract

One org annotation per state change (no `dashboardUID`):

| Field | Value |
|---|---|
| tags | `nais-apm:triage`, `app:<namespace>/<service>`, `fp:<fingerprint>` |
| text | `{"schema":1,"action":"resolve"\|"ignore"\|"unresolve"\|"assign","actor":"<login>","assignee":"…","resolvedInVersion":"…","note":"…"}` |
| time | write timestamp (ms) |

State is folded **newest-event-wins** at read time, with status events
(resolve/ignore/unresolve) and assign events folding independently —
assigning never flips status. The fold lives behind the Go `TriageStore`
interface (`pkg/plugin/triage.go`); a future real database (#57 Phase 2)
migrates by replaying the event log.

Per-user mutes are separate: they live in Grafana's plugin **user storage**
(`src/utils/userStorage.ts`) and never touch shared state.

## Endpoints

```
GET  /services/{ns}/{svc}/triage                         → { states: { <fp>: {status, assignee?, resolvedInVersion?, updatedAt, updatedBy} } }
POST /services/{ns}/{svc}/triage/{fingerprint}           ← { action, assignee?, resolvedInVersion?, note? } → new folded state
GET  /services/{ns}/{svc}/triage/{fingerprint}/history   → { events: [...] } oldest-first
```

The actor is resolved server-side from the signed-in Grafana user — anyone
with plugin access may triage (Sentry model), but always attributably.
Reads are deliberately uncached: read-after-write matters more than saving
one indexed Grafana DB query.

## Consistency expectations

- A state change is durable once the annotation POST returns — it is in
  Grafana's shared database, visible to every replica's next read
  (well within the 30s target; there is no per-replica cache on this path).
- Concurrent conflicting actions are last-write-wins per event, which is
  benign: two people resolving the same issue converge on resolved.

## Deployment requirement: annotation retention

Grafana can be configured to clean up API annotations. **That configuration
deletes triage history.** The following must stay at their defaults (0 =
keep all) on any Grafana hosting this plugin:

```ini
[annotations.api]
max_age = 0
max_annotations_to_keep = 0
```

The backend checks `/api/admin/settings` on the first triage write of each
plugin process and logs a warning when retention is bounded (silent when the
service account lacks admin scope).

### Deploy-marker pruning

`[annotations.api]` retention is org-wide, so keep-all also keeps every deploy
marker forever — and those churn (one per deploy of every service) where triage
events are sparse. The nais deploy sync therefore prunes them itself, once a
day: `nais-apm:deploy` markers older than 90 days are deleted **except** the
newest per namespace, service and environment, which regression detection
anchors on.
Markers inside the window are untouched (dashboard overlays, release health),
and triage annotations are never deleted.

## Regression semantics (naive Phase 1)

An issue whose folded state is `resolved` but which still has occurrences in
the current query window **and** whose resolve predates the newest deploy
annotation (`nais-apm:deploy`, see #64) renders as **Regressed** and bubbles
to the top of the default view. This is a documented approximation — when
viewing historical windows, occurrences may predate the resolve. Exact
regression detection (per-version occurrence tracking) is #57 Phase 2.

## HA verification procedure (kill-two-replicas test)

To be executed against a two-replica Grafana sharing one database
(documents the #57 exit criterion; the local docker stack is single-replica):

1. Open the same service's Issues tab on replica A and replica B.
2. Resolve an issue on A → within one refresh, B's default view hides it
   (its `GET /triage` reads the shared DB).
3. Start a resolve on A and `kill -9` A's Grafana process mid-request.
   Verify on B: either the annotation was written (state = resolved) or it
   wasn't (state unchanged) — no torn/corrupted state is possible because a
   state change is a single-row annotation insert.
4. Restart A; verify both replicas agree, and `GET /triage/{fp}/history`
   shows a consistent, ordered event list.
