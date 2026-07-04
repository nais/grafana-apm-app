# Security model — resource endpoints

> Source: 2026-07-04 security audit of the M5–M7 endpoints. Injection, resource
> limits, cache-key org scoping, and error disclosure were all verified clean
> (every user value is sanitized for its sink's grammar; every raw read is
> capped; every cached handler keys on `X-Grafana-Org-Id`). The open items are
> authorization design, below.

## Authorization as implemented

- **Gate:** all `/api/plugins/nais-apm-app/resources/*` endpoints require an
  authenticated Grafana session (Viewer minimum with the app enabled). There is
  no per-endpoint role check by default — `UserFromContext` is used for
  attribution, not authorization.
- **Downstream credential:** handlers call datasources and Grafana APIs with the
  plugin **service-account token** (fleet-wide read is the intended APM model),
  falling back to forwarding the caller's headers only when no SA token is set.
- **Writes:** the only writes are `POST /api/annotations` (triage + deploy sync)
  and `POST .../settings` (ops watchlist). No `PUT`/`DELETE` to Grafana exists.

## Hardened (2026-07-04)

- **Ops-watchlist write now requires Editor/Admin** (`requireEditor`, authz.go):
  the write goes through the Admin-scoped SA token, so a Viewer must no longer be
  able to drive it (confused deputy). Fails closed when the role is absent.
- **Datasource-UID allowlist** on `/logs/patterns` and `/traces/breakdown`
  (`EnvAwareDataSource.Allows`): the client-supplied `lokiUid`/`tracesUid` is
  proxied with the SA token, so only the configured logs/traces datasource UIDs
  are accepted — never an arbitrary UID the SA happens to reach.

## Accepted design decisions (Hans, 2026-07-04)

Both are the intended "anyone with plugin access participates" model. Reviewed
and **kept as built** — recorded here so future audits read them as deliberate,
not oversights:

1. **Triage writes are open to any plugin user (Sentry parity).** `POST
   /triage/{fp}` records an org annotation with the SA token; any authenticated
   user (incl. Viewer) can resolve/ignore/assign, always attributed. Decision:
   keep it — collaborative triage is the product intent; the risk is low
   (constrained data, recorded actor). NOT gated on Editor (unlike the
   ops-watchlist settings write, which IS gated because it mutates plugin
   config). Multi-org note: triage writes forward no org-id, so state lives in
   the SA's single org — fine for nais's single-org deployment; revisit if a
   multi-org deployment is ever introduced.
2. **Scorecard ownership is fleet-wide.** `/scorecard` resolves any namespace's
   Console ownership facts (team, Slack channel, repo, ingress URLs) via the
   shared nais API token with no caller-team check. Decision: keep it —
   cross-team visibility ("whose failing dependency is this, who do I contact")
   is much of the point, and the fields are low-sensitivity contact/repo
   metadata, not secrets.

## Verified clean (no action)

Injection (LogQL/PromQL/TraceQL/GraphQL/path — every sink sanitized to a grammar
it can't break out of), SSRF/traversal via UID params (charset blocks `/.%`),
resource limits (every list/read capped; probe concurrency bounded), cache-key
org scoping (all 25 cached handlers key on org-id; the two non-org caches hold
fleet-wide non-tenant data by design), error disclosure (upstream error bodies
log-only; clients get generic strings; secure fields exposed as booleans), and
the data-review harness (no committed secrets; `admin:admin` is the documented
local-dev default, env-overridable).
