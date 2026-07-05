# Information-architecture review (2026-07-03)

> **Status: shipped.** This is the first IA review; every move below landed
> (the dedicated **Issues** tab, VersionsPanel/SessionsPanel relocation, the
> Console-Errors/Exception-Types cleanup, the vitals-first Frontend reorder,
> the drawer reorder, and the URL-contract addendum). The proposed tab order
> here (`Overview · Issues · Endpoints · Frontend · Runtime · …`) was later
> **superseded** by [ia-review-2.md](ia-review-2.md), which merged Endpoints +
> Runtime into a single **Backend** tab and added an **Alerts** tab. Kept as a
> design record of how the Issues split was decided; the "Open questions"
> below were subsequently resolved (see ia-review-2.md and url-contract.md).

Placement inventory and move proposal for everything shipped through the
M0–M6 pass, measured against docs/design-philosophy.md. One decision is
already made: the unified Issues table gets a dedicated service-page tab
(default source **all**) while the Frontend tab keeps a browser-scoped view.

## Diagnosis

The Frontend tab currently answers **three** primary questions — UX health,
error triage, and user support — which is over its cognitive-load budget and
against "one primary question per page". The Issues-tab decision fixes the
biggest one; the rest of the moves follow from it.

## Prioritized move list

| P | Move | Why | Effort |
|---|---|---|---|
| 1 | **Issues tab** (`tab=issues`; source=all, filter=unresolved; hosts IssuesTable + ExceptionDrawer) | The product's differentiator is buried three rows deep in a frontend-named tab backend devs never open | M |
| 2 | **VersionsPanel → Issues tab** (below the table) | Regression semantics already join issues↔versions; "did this start with today's release?" is triage context, not UX telemetry. No separate Releases tab — one panel doesn't earn one | S |
| 3 | **SessionsPanel → Issues tab** (bottom) | "Ticket in, session out" is investigation, not performance monitoring. Promote to a standalone page later if replay adoption warrants | S |
| 4 | **Remove Console Errors table** from Frontend | Duplicated since console captures flow into Top Exceptions (0.13.0) and are badged in the drawer (#66) | S |
| 5 | **Drop Exception Types panel**; revisit as a type *facet* on the Issues tab (M6 faceted search). Exception: keep it in the no-Loki fallback path where it is the only errors surface | Two panels answering one question | S |
| 6 | **Frontend tab reorder — vitals first**; Issues stays as ONE compact browser-scoped row (≈5 rows) with an "All issues →" link, no Versions/Sessions beneath | The tab's primary question reverts to "is the UX healthy?"; symptoms lead | S |
| 7 | **Rename tab label "Operations" → "Endpoints"** (URL `tab=server` unchanged per url-contract) | Collides with the Overview section literally titled "Operations" | S |
| 8 | **Drawer internal reorder** (no feature removed): 1 triage bar + compact impact strip · 2 stack trace · 3 occurrence context (collapapsed) · 4 breadcrumbs (collapsed) · 5 replay (probe-gated) · 6 footer links/alert | Developer's first question is "where in my code?" — the tall Context/Impact block currently front-loads | M |
| 9 | **Custom metrics collapsible on Overview** (default collapsed, count in header) | Overview budget is RED-first; unbounded auto-discovered panel violates it until #68 P1 curation | S |
| 10 | **URL-contract addendum**: `issueId` resolves on both tabs; alert-template deep links point at `tab=issues`; `tab=frontend&issueId=…` and `exceptionHash` keep resolving forever | Context survives navigation | S |

Proposed tab order (symptom → cause):
`Overview | Issues | Endpoints | Frontend | Runtime | Dependencies | Traces | Logs`
— Issues second (only tab answering "do I need to act" directly), capability-gated
on Loki like Logs.

## Target layouts

```
ISSUES TAB (new)                          FRONTEND TAB (after moves)
┌────────────────────────────────┐        ┌────────────────────────────────┐
│ Issues [All|Browser|Server]    │        │ Web-vitals bullets             │
│        [Unresolved|All|…]      │        │ CWV rating │ Pageloads │       │
│  row → ExceptionDrawer         │        │ Sessions stat │ Nav type      │
├────────────────────────────────┤        ├────────────────────────────────┤
│ Versions (adoption, error-free │        │ Issues — browser, compact 5    │
│ %, deploy times)               │        │ rows → "All issues →"          │
├────────────────────────────────┤        ├────────────────────────────────┤
│ Sessions (search user/session) │        │ Vitals p75 trends              │
└────────────────────────────────┘        │ Attribution (LCP/INP/CLS)      │
                                          │ Per-page performance           │
                                          │ Browser breakdown │ volume     │
                                          │ Traffic row                    │
                                          └────────────────────────────────┘
```

## Open questions (for Hans)

1. Versions data on the Frontend tab's compact list — fetch silently for the
   Regressed badge, or accept Regressed surfacing only on the Issues tab?
2. Server-issue drawer parity: prerequisite for Issues-tab GA, or does the
   Logs deep link suffice for v1? (#63 P1 says parity; code punts today.)
3. Sessions: Issues-tab section now vs holding for a standalone page — moving
   twice costs a URL-contract entry each time.
4. `tab=endpoints` as an alias with two-release deprecation, or label-only rename?
5. Any team relying on the type-level Exception Types view outside the
   no-Loki fallback?
6. Keep the Sessions *stat* in the insights row even after the Sessions
   *panel* moves? (Trend vs search are different questions — proposal: yes.)
