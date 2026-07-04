# Nais APM plugin resource API

This is the canonical technical reference for the Nais APM app plugin's HTTP
resource API. These endpoints power the plugin UI, but they are also useful for
automation: CI gates ("fail the pipeline if this release introduced new
unresolved issues"), Slack bots (digest of regressed issues), and platform
tooling.

The user-facing halves of this material live in the nais docs
(`observability/apm/reference`). This page is the source of truth that those
docs link to.

> **Scope of the stability promise.** Only the endpoints marked **stable**
> below carry a compatibility guarantee. Everything else is **experimental** and
> may change shape without a deprecation window. See
> [Stability contract](#stability-contract).

## Endpoint groups

| Group | Page | Endpoints |
| --- | --- | --- |
| Issues, exceptions & triage | [issues.md](./issues.md) | `/issues`, `/exceptions/groups`, `/triage`, `/triage/{fingerprint}`, `/triage/{fingerprint}/history` |
| Frontend (Faro) | [frontend.md](./frontend.md) | `/frontend`, `/frontend/versions`, `/frontend/sessions`, `/feedback` |
| Analytics | [analytics.md](./analytics.md) | `/logs/patterns`, `/traces/breakdown` |
| Platform | [platform.md](./platform.md) | `/capabilities`, `/scorecard`, `/jobs`, `/service-map`, `/service-map/clustered` |
| Alert templates | [alert-templates.md](./alert-templates.md) | `/alert-templates/{kind}` |
| Services, health & topology | [services.md](./services.md) | `/services`, `/health`, `/operations`, `/endpoints`, `/runtime`, plus experimental dependency/graphql endpoints |

A machine-readable [OpenAPI 3.0 document](./openapi.yaml) covers the stable
endpoints in full and the experimental ones at least by path/method. A Go test
(`pkg/plugin/apidocs_test.go`) walks the routes registered in `app.go` and fails
if any route is missing from `openapi.yaml`, so this reference cannot silently
drift from the code.

## Base URL

Every endpoint is served under the Grafana plugin resources proxy:

```
{GRAFANA_URL}/api/plugins/nais-apm-app/resources/{path}
```

For example, `/issues` for a service is:

```
{GRAFANA_URL}/api/plugins/nais-apm-app/resources/services/{namespace}/{service}/issues
```

The plugin backend runs inside the Grafana process. It reaches Mimir, Tempo and
Loki through Grafana's datasource proxy on localhost, so callers never talk to
those datasources directly — they only ever call the resources proxy above.

## Authentication

The resources proxy is a normal Grafana API surface, so it accepts any
credential Grafana itself accepts:

- **Interactive / browser** — the Grafana session cookie. This is what the
  plugin UI uses.
- **Automation (CI, bots)** — a **Grafana service account token** sent as
  `Authorization: Bearer <token>`. Create the service account in Grafana
  (Administration → Service accounts) with at least **Viewer** on the org. That
  is sufficient for every read endpoint. Writing triage state
  (`POST /triage/{fingerprint}`) additionally creates a Grafana annotation, so
  the service account needs annotation-write (Editor role, or a fine-grained
  annotations:write permission).

There are no plugin-specific API keys — Grafana service accounts are the only
token mechanism, by design.

The plugin forwards the caller's identity down to the datasource proxy. When the
plugin is deployed behind an OAuth2 proxy (Wonderwall/Nais) it may also use a
configured Grafana service account token internally for datasource calls; that
is an install-time concern and does not change how you authenticate as a caller.

The actor recorded on a triage write is resolved from the Grafana user on the
request (`X-Grafana-User` / SDK user context), falling back to `"unknown"` when
the call is made with a service-account token that carries no user identity.

## Caching semantics

Most read endpoints keep a short-lived in-memory response cache to protect the
datasources from wallboard-style polling.

- **Default TTL: 30 seconds.** (`/capabilities` and `/scorecard` use a longer
  **5 minute** TTL; `/capabilities` additionally drops to a 30 s negative TTL
  when no span metrics are detected.)
- Cache keys incorporate the Grafana org id (`X-Grafana-Org-Id` header), the
  sanitized path/query parameters, and the time range **rounded down to a 30 s
  bucket**, so near-simultaneous requests with slightly different `from`/`to`
  share an entry.
- Concurrent misses for the same key are coalesced into a single upstream query
  (singleflight stampede protection).

### The `X-Cache` header

- On a **cache hit** the plugin sets `X-Cache: HIT`.
- On a **cache miss** the plugin sets **no** `X-Cache` header (there is no
  explicit `MISS` value).
- Grafana's own resource proxy **also injects an `X-Cache` header** reflecting
  its enterprise query-cache status — commonly `X-Cache: DISABLED`. This is
  unrelated to the plugin's cache. As a result a cached response can carry
  **two** `X-Cache` header values (`DISABLED` from Grafana and `HIT` from the
  plugin). When reading the header programmatically, look for the plugin's `HIT`
  value specifically; do not treat a lone `DISABLED` as meaningful.

The triage read/write endpoints (`/triage*`) and alert templates are **never
cached** (read-after-write correctness / cheap to compute).

## Conventions

- **Method:** all endpoints are `GET` except `POST /triage/{fingerprint}`.
  A non-matching method returns `405` with body `method not allowed`.
- **Time range:** `from` and `to` are **Unix epoch seconds**. Both default to a
  trailing one-hour window (`from = now-1h`, `to = now`). Unparseable values
  fall back to the default silently. Some endpoints (runtime, endpoints,
  operations, jobs) are point-in-time and use only `to` as the query instant.
- **Timestamps in responses** are **epoch milliseconds** (field names ending in
  `Ms`) unless a field name says otherwise.
- **Parameter sanitization:** label-like params (`service`, `namespace`,
  `environment`, facet values) are validated against
  `^[a-zA-Z0-9._\-/ :@]+$` (max 256 chars); anything that fails is treated as
  empty rather than erroring. `namespace` accepts the placeholder `_` meaning
  "no namespace". Datasource UID params match `^[a-zA-Z0-9_-]{1,64}$`.
  Fingerprints in the triage path match `^[a-z0-9:]{1,64}$`. Per-endpoint rules
  are noted on each group page.
- **Missing service:** endpoints under `/services/{namespace}/{service}/…`
  return `400 {"error":"missing or invalid service"}` when the service segment
  sanitizes to empty.
- **Datasource not configured:** endpoints degrade in one of two ways. Metrics
  endpoints that cannot function return `503` (plain text or
  `{"error":"metrics datasource not configured"}`). Loki/Tempo-backed endpoints
  instead return `200` with a structured "unavailable" body (e.g.
  `{"unavailable":true}` or `{"mode":"unavailable"}`) so the UI can degrade
  gracefully.
- **Content type:** `application/json`.

## Calling from CI

Read `/issues` for a service using a Grafana service account token:

```bash
curl -sf \
  -H "Authorization: Bearer $GRAFANA_SA_TOKEN" \
  "$GRAFANA_URL/api/plugins/nais-apm-app/resources/services/fager/min-side-arbeidsgiver/issues"
```

A complete, runnable GitHub Actions gate that fails a deploy when new issue
fingerprints appear is in
[examples/ci-gate.md](./examples/ci-gate.md).

## Stability contract

Stability is enforced **socially** (PR review + a checklist), not by tooling.
The route-walking test only guarantees that every route is *documented*, not
that its shape is frozen.

### Stable endpoints

These have settled request/response shapes and a compatibility promise:

| Endpoint | Notes |
| --- | --- |
| `GET /capabilities` | Datasource/feature detection. |
| `GET /services/{namespace}/{service}/issues` | Merged browser + server issue list. |
| `GET /services/{namespace}/{service}/exceptions/groups` | Fingerprint-grouped frontend exceptions. |
| `GET /services/{namespace}/{service}/triage` | Folded triage state per fingerprint. |
| `POST /services/{namespace}/{service}/triage/{fingerprint}` | Record a triage action. |
| `GET /services/{namespace}/{service}/triage/{fingerprint}/history` | Triage event log. |

**The promise for stable endpoints:**

- **Additive only.** New response fields and new optional query parameters may be
  added at any time. Consumers **must** ignore unknown fields.
- **No removals or renames** of existing fields, query parameters, paths, or
  documented enum values without a **deprecation window of at least one minor
  release** and a `CHANGELOG` entry describing the migration.
- The `fingerprintVersion` field (`v1`) signals the fingerprinting algorithm. A
  breaking change to fingerprint computation bumps this value rather than
  silently changing existing fingerprints.

### Experimental endpoints

Everything else — frontend/Faro, analytics (patterns, breakdown), platform
(scorecard, jobs, service-map), alert templates, and the topology/services
endpoints (`/services`, `/health`, `/runtime`, `/endpoints`, `/operations`,
`/dependencies`, `/connected`, `/graphql`, `/custom-metrics`, namespace
endpoints, ops-watchlist) — is **experimental**. They are documented and usable,
but their shapes may change without a deprecation window. Pin to a plugin
version if you build automation on them.

Rationale: the stable set is the surface consumed by external automation today
(CI gates and bots read issues/triage/exceptions and probe `/capabilities`). The
experimental set is either newer (scorecard/jobs/service-map landed in the M6–M7
waves and are still settling) or primarily UI-shaped and subject to iteration.
`/services` and `/health` are mature but are intentionally kept experimental
because their series-bearing shapes are still tuned for the UI.
