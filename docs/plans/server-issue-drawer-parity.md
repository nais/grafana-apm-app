# Implementation plan: server-issue drawer parity (#63 P1)

Status 2026-07-04: **not started, deliberately deferred.** Server-source issue
rows in `IssuesTable` deep-link to the Logs tab (pre-filtered on the error
title); browser rows open `ExceptionDrawer`. This document is the precise plan
to give server issues a drawer too. It is filed rather than half-built because
parity needs a **new backend endpoint plus a new drawer component** — not a
bounded in-place edit — and one piece (per-shape app-version attribution) was
explicitly punted in Phase 1 and is a prerequisite here.

## Why the current drawer cannot render a server issue

`ExceptionDrawer.tsx` is hardwired to the Faro exception stream and its logfmt
shape. Concretely, it:

- keys entirely on `hashes[]` (Alloy `xxh3` hashes) — queries
  `{service, kind="exception"} |~ hash | logfmt | hash=~"(…)"`. **Server issues
  carry no Alloy hash**: `queryServerExceptionGroups` sets `MemberHashes: []`
  (they are grouped from backend logs, which have no Alloy `hash` label).
- parses Faro-only logfmt fields: `stacktrace`, `browser_*`, `page_*`,
  `session_id`, `user_*`, `app_version`. Backend logs carry none of these in
  that shape; they arrive in three different shapes (semconv structured
  metadata / JSON body / plain text — see `issues.go`).
- drives breadcrumbs, replay probe, and the session picker off `session_id`,
  which backend logs do not have.

So the drawer has no query it can run and no fields it can parse for a server
issue. What a server issue *does* carry today (`Issue` in `issues.go`):
`fingerprint`, `tier`, `title`, `types[]`, `count`, `impact.pods`. No stack, no
sample line, no sessions, no versions (`impact.versions` is always `[]`).

The fingerprint is a one-way hash, so occurrences cannot be reconstructed from
it — they must be **re-queried** from Loki and filtered by recomputing the
fingerprint per row (exactly as the issues list already does).

## Data availability per backend shape (governs what the drawer can show)

| Shape | Stack trace | Pods | Versions | Sessions |
|---|---|---|---|---|
| (a) semconv OTLP | ✅ `exception_stacktrace` structured metadata | ✅ `k8s_pod_name` | needs label survey | ✗ |
| (b) JSON body | ⚠️ inconsistent (`stack_trace`/`stacktrace`/`error.stack`, often absent) | ✅ | needs label survey | ✗ |
| (c) plain text | ⚠️ raw line only (may be a multi-line dump, may be one message) | ✗ (sample carries no pod) | ✗ | ✗ |

So a server drawer shows: **stack when the shape has one**, pods/endpoints
impact, recent sample occurrences (raw line + timestamp + pod + version), and
keeps the "View in Logs" deep link. It never shows sessions/breadcrumbs/replay
(those are browser-only concepts) — the drawer must degrade those sections away
by source, not render empty shells.

## Prerequisite (blocks a full-fidelity impact strip)

`impact.versions` is empty in Phase 1 because app-version attribution needs a
per-shape version-label survey against real NAV logs (semconv resource attr vs
JSON `version`/`app_version` field vs a stream label). The drawer can ship
without versions (show pods + endpoints first), but "impacted versions" and any
regression cross-link on server issues wait on that survey. Do the survey with
`scripts/data-review.sh` reachable (VPN) before promising versions.

## Plan (files + shapes)

1. **Backend — `pkg/plugin/issues.go` (owned) + route in `app.go`:**
   `GET /services/{ns}/{svc}/issues/{fingerprint}/occurrences?from&to&env`
   (server source). Reuse the three-shape query builders from
   `queryServerExceptionGroups`, but as **log** queries (newest-N, cap ~100)
   instead of count aggregations, plus the semconv/JSON stack fields in the
   `| keep`. For each returned row: recompute `fingerprint.Compute` and keep
   only rows matching the requested fingerprint. Extract per row: message,
   type, stacktrace (shape a/b), pod, version (post-survey), timestamp, raw
   line. Return `{stack?, sampleOccurrences: [...], impact: {pods, endpoints?,
   versions?}, firstSeenMs, lastSeenMs, total}`. Cache via `writeCached` like
   the other handlers. Tests in `issues_test.go` mirroring the existing
   fake-proxy pattern (one fixture per shape, assert fingerprint filtering and
   stack extraction).

2. **Frontend — `src/api/client.ts`:** `getServerIssueOccurrences(ns, svc,
   fingerprint, from, to, env)` returning the shape above.

3. **Frontend — new `ServerIssueDrawer.tsx`** (sibling of `ExceptionDrawer`,
   same directory, owned). Reuse `TriageControls` (already source-agnostic —
   keyed on `issueId`), `StackTraceView`, the impact strip, and
   `FeedbackSection` (feedback joins by fingerprint, source-agnostic). Render
   server-specific context: pods, endpoints, sample occurrences list (raw line
   + pod + version + time), and a prominent **"View in Logs"** button (the
   current deep link, retained inside the drawer). No sessions / breadcrumbs /
   replay sections. Show a `server` source badge in the drawer header.

4. **Frontend — `IssuesTable.tsx` (owned):** change the server-row `onOpen`
   from `updateParams({ tab: 'logs', logSearch: … })` to
   `updateParams({ issueId: g.fingerprint, issueSource: 'server' })`, and have
   the host (Frontend/Issues tab) pick `ServerIssueDrawer` vs `ExceptionDrawer`
   off the `issueSource` param. Keep the row's external-link affordance only as
   a secondary "open in Logs" action, not the primary click. Update
   `docs/url-contract.md` for the new `issueSource` param.

5. **Tests:** `issues_test.go` (occurrence endpoint, per shape);
   `ServerIssueDrawer.test.tsx` (renders stack when present, degrades sessions
   away, "View in Logs" retained, triage bar mounts); update
   `IssuesTable.test.tsx` for the new server-row open behavior.

## Scope estimate

New backend endpoint + 3-shape occurrence extraction (~120 LoC + tests), new
~250-LoC drawer component, IssuesTable wiring, url-contract entry. ~M effort.
Not bounded enough to fold into a hardening pass; sequence as a dedicated task
after the version-label survey lands.
