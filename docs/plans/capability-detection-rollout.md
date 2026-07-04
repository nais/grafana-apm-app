# Capability-detection rollout — retiring fallbacks safely

The plugin carries several fallbacks that work around pipeline gaps
(`docs/platform-pipeline-recommendations.md`). Each gap has a helm PR that
closes it. **The fallback must not be removed when the helm PR merges — only
after it has deployed and backfilled.** To make that transition safe and
zero-touch, the plugin adopts **capability-detection**: prefer the fast path
when the pipeline provides it, keep the fallback for data that predates the
rollout, and delete the fallback only once the fast path is fleet-universal.

This is the agreed strategy (Hans, 2026-07-04) and good defensive practice —
the plugin works correctly *before, during, and after* each pipeline change
with no coordinated deploy.

## The pattern

For each item: a cheap capability probe (does the new metric/field exist for
this service in this window?) chooses the path per-request. The probe result
is cached like other capability checks. The fallback stays until a later
cleanup, by which point the probe always returns "present" and the fallback
code is provably dead.

## The three couplings

| Fallback (plugin) | Helm PR (gap) | Capability probe | Fast path | When to delete the fallback |
|---|---|---|---|---|
| `sessionsFallbackWindows` ladder — `pkg/plugin/exceptions.go` | `apm/loki-session-recording-rule` (P1.2) | is the session-count recording metric present for the service? | read the pre-aggregated distinct-sessions metric from Mimir (**cheap but an UPPER BOUND** — see caveat) | fallback is **not fully deletable** — keep the ladder for exact counts |
| 3-shape server-log probe — `pkg/plugin/issues.go` | `apm/collector-exception-normalization` (P1.1) | do error logs carry `exception.type`/`message` structured metadata? | single label-filter query on the normalized fields (exact counts, no sampling) | once normalization covers the fleet AND historical retention has rolled over |
| dual-pool query — `pkg/plugin/runtime.go` | none (instrumentation heterogeneity, not a helm change) | n/a | n/a | **never via a helm change** — apps genuinely emit both metric families; only a fleet-wide instrumentation migration would let this go |

## Sequencing per item

1. Helm PR reviewed + merged by the platform team.
2. Deployed; recording rule / normalization begins producing data.
3. Backfill/retention window passes so the fast path covers the ranges the
   plugin queries.
4. **Then** implement the plugin capability-detection change (a small PR each):
   probe → fast path when present, existing fallback otherwise. Ship it.
5. Monitor: once the probe is universally "present" for a full retention
   window, a final cleanup PR deletes the now-dead fallback.

## Caveat — the session metric is an approximation, not a replacement

Draft branch `apm/loki-session-recording-rule` established that Loki/PromQL
cannot express an exact distinct-session-count *across a time range* (recording
rules are per-interval snapshots; there is no count-distinct-across-time / HLL).
The rule emits **distinct sessions per 1-minute bucket**, which is exact within
a bucket but an **upper bound** when summed over a wider range (a session
spanning N minutes is counted once per minute). Consequences:

- The recording metric is the right **default** on wide ranges (cheap, no
  `max_query_series` blowup, good enough for ranking issues) — the plugin
  should prefer it and label the number as approximate over long windows.
- The narrowing `sessionsFallbackWindows` ladder stays as the **exact** path for
  short ranges — so unlike the exception-normalization case, this fallback is
  **not deleted**, it becomes the "exact, recent-window" complement to the
  "approximate, any-range" metric. Capability-detection here is a *presentation*
  choice (which number to show at which range), not a fallback-retirement path.
- The exception-normalization fallback (3-shape probe) is the same story only
  partially: the collector branch normalizes OTLP fully but JSON only partially
  (no `exception_type`) and plain text not at all, so that fallback also shrinks
  rather than disappears until instrumentation converges.

## Why not build the detection now (in PR #71)

The fast paths detect metrics/fields that **do not exist yet** (the helm PRs
are unmerged). Building the detection now would add code that is dormant until
deploy and can't be verified end-to-end — dead weight in a PR that ships
verified work. So the capability-detection changes are **follow-ups paired to
each helm PR's deployment**, tracked here. The one exception is anything using
*already-enabled* config (e.g. the `detected_level` severity filter, the p75
web-vitals fix) — those need no detection and ship in PR #71 directly.

## Non-goal

Removing a fallback ahead of its deploy. Every fallback in the table above is
load-bearing today (verified: none of the three gaps is closed in the current
`helm-charts/features/` config). Defensive-by-default stays.
