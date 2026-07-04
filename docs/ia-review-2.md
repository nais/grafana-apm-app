# IA review 2 — a rubric for tab/layout decisions (2026-07-04)

The first review (`docs/ia-review.md`) settled the Issues-tab split and the
M6 moves. This round answers a batch of layout questions — Traces/Logs
breakdown size, Overview duplication, an Endpoints+Runtime merge, an Alerts
tab — but the real deliverable is the **rubric** that makes these (and future)
answers fall out consistently, so layout stays principled instead of accreting.

## The rubric

Every tab and panel is judged against six rules:

1. **One primary question per tab.** A tab exists to answer exactly one
   question a real user asks, stateable in a sentence. If you can't, the tab is
   doing too much.
2. **Persona-anchored.** Each question belongs to someone: on-call ("is it
   broken *now*?"), the owning developer ("*why*, and *where in my code*?"),
   the team/platform lead ("is it healthy *over time*?").
3. **No content lives in two places.** A panel earns its spot only if this tab
   is its *best* home. The Overview is the exception that proves the rule: it
   shows **signals and links, never the full detail** — a signal is a summary
   plus a click, not a copy of another tab.
4. **Symptom → cause → investigate ordering.** Left-to-right, tabs go from "do
   I need to act?" (symptoms) to "why / where" (causes) to "let me dig"
   (raw investigation surfaces).
5. **Investigation surfaces put the primary object first.** On Traces/Logs the
   user came for traces/logs; summaries and breakdowns are secondary and must
   not push the primary list below the fold.
6. **Content-gate, don't clutter.** A tab or section with no data for this
   service collapses or hides (Profiling/Database/Jobs already do this) rather
   than showing an empty shell.

## Answers (each falls out of the rubric)

### Traces/Logs breakdown panels are too tall — rule 5
The TraceQL breakdown (`traces/TraceBreakdowns`) and log Patterns
(`logs/PatternsPanel`) sit *above* the primary list, so the user scrolls past a
summary to reach the traces/logs they came for. **Fix:** collapse them by
default (ControlledCollapse) and cap to top-N with "show more"; the
traces/logs list is the first thing above the fold, the summary is one click
away. Low-risk, philosophy-aligned — **implement now.**

### Overview duplicates other tabs — rule 3
`OverviewTab` currently embeds the full topology **graph** and the
callers/**Dependencies** tables — a verbatim slice of the Dependencies tab —
alongside its genuine signals (health header, SLO, attention, custom metrics).
**Fix:** Overview keeps the actionable signals and replaces the full
graph/tables with a **one-line dependency signal** ("3 unhealthy upstreams →")
that links to Dependencies. Overview answers "is this service healthy and what
needs attention?" — nothing that is merely a copy. **Implement now.**

### Merge Endpoints + Runtime → "Backend"? — rules 1, 2, 4 → **yes, as sections**
Endpoints answers **RED** (workload: rate/errors/duration per operation);
Runtime answers **USE** (resources: utilization/saturation). Different lenses,
but the same persona (backend developer) asks both when diagnosing "my service
is unhealthy — is it the workload or the resources?". Merging into one
**Backend** tab with two clearly-labeled sections — Endpoints (RED) on top,
Runtime (USE) below — (a) cuts the tab count (9–10 is a lot), (b) matches the
mental model "the server side of my service", (c) orders symptom→cause (slow
endpoints → saturated resources). Mitigate the scroll with rule 6: collapse the
Runtime/USE section when resources are nominal. Database stays a separate tab
(specialized + capability-gated) but the Backend tab links to it. *This is a
visible restructure — decision required.*

### An Alerts tab? — rules 1, 2, 3 → **yes, service-scoped, content-gated**
Today alert *rules* live on the namespace page, "create alert" is scattered
(drawer + SLO panel), and firing detail (#32/#33) is unbuilt. A service Alerts
tab answers one question — "what's watching this service, and is anything
firing?" — and becomes the natural home for #32/#33 (firing state, silences,
contact points, rule list + the create-alert templates). Overview shows a
firing-alert *signal* (count + link, per rule 3); the Alerts tab owns the
detail. Content-gate: no rules → a compact "no alerts configured — create one"
state. Position it early (a "do I need to act?" surface). *Decision required.*

## Proposed tab structure

Current: `Overview · Issues · Endpoints · Frontend · Runtime · Database · Dependencies · Traces · Logs · (Profiling)`

Proposed: `Overview · Issues · Alerts · Backend · Frontend · Database · Dependencies · Traces · Logs · (Profiling)`

- **Overview** — signals + attention only (de-duplicated)
- **Issues** — errors + triage (unchanged)
- **Alerts** — *new*: rules + firing state + silences + create (home for #32/#33)
- **Backend** — *merge*: Endpoints (RED) + Runtime (USE) sections
- **Frontend** — unchanged (distinct persona: browser/UX)
- **Database / Dependencies / Traces / Logs / Profiling** — unchanged in scope;
  Traces/Logs get the breakdown-collapse fix; Dependencies is where Overview's
  dependency signal links.

Left-to-right this reads act → why → where, one question per tab, one home per
panel — the rubric, applied.

## How we keep this holistic going forward

- **Every new tab/panel states its one question and persona in its PR** (a
  one-line "answers: …, for: …"). If it duplicates an existing home, it's a
  signal+link, not a copy.
- **Re-run this rubric each milestone** (as ia-review.md / this doc did) —
  measure the layout against the six rules, not against "where did we happen to
  put it."
- **RED / USE / errors is the diagnostic backbone** — Endpoints=RED,
  Runtime=USE, Issues=errors; keep that vocabulary so panels have an obvious
  home.
