# Real-environment smoke tests

A repeatable check of the **real-environment contracts** the plugin depends on —
the seams where the backend reaches something outside its own code (Grafana's
alert-rule editor, the nais API, a signed-in user context, live datasources).
These are exactly the things unit tests cannot verify, because they only exist
once the plugin is wired into a running Grafana with real datasources.

It complements `data-review.sh`, it does not overlap it:

| harness            | question it answers                                            |
|--------------------|---------------------------------------------------------------|
| `data-review.sh`   | **conformance** — do endpoints return the right *data shapes*? |
| `smoke-test.sh`    | **contracts** — do the real-environment *seams* still hold?    |

## Running the harness

```bash
bash scripts/smoke-test.sh
```

Env overrides (all optional):

| var                  | default                        | meaning                                                     |
|----------------------|--------------------------------|-------------------------------------------------------------|
| `HOST`               | `http://localhost:3000`        | Grafana base URL                                            |
| `AUTH`               | `admin:admin`                  | basic-auth `user:pass`                                      |
| `MAXTIME`            | `90`                           | per-request curl timeout (seconds)                          |
| `RANGE_SECS`         | `21600` (6h)                   | lookback window for the deploy-sync query                   |
| `AT_NS` / `AT_SVC`   | `pdl` / `pdl-api`              | service used for the alert-template + triage checks         |
| `DEPLOY_NS`/`DEPLOY_SVC` | `navno` / `nav-enonicxp-frontend` | recently-deployed service for the deploy-sync check   |
| `EXPECT_DEPLOY_SYNC` | _(unset)_                      | set `1` when a nais API token **is** provisioned            |
| `USER_TOKEN`         | _(unset)_                      | a Grafana **user** API token to attribute triage as a real login |
| `VERBOSE`            | `0`                            | set `1` to print body snippets on FAIL                      |

Example with deploy sync expected and a real user token:

```bash
EXPECT_DEPLOY_SYNC=1 DEPLOY_NS=navno DEPLOY_SVC=nav-enonicxp-frontend \
  USER_TOKEN=glsa_… bash scripts/smoke-test.sh
```

Exit code is `0` when no check **FAILs** (SKIPs are fine), `1` if any check
FAILs. The guiding rule: **every check SKIPs — never FAILs — when its
precondition is absent**, so the script is runnable in any environment and only
goes red on a genuine contract break.

## What each check covers

### 1. Alert-template `defaults=` contract

For each alert-template kind (`error-rate`, `exception-spike`, `web-vitals`,
`new-exceptions`, `slo-burn-rate`) the harness fetches `/alert-templates/{kind}`,
parses the returned `url`, extracts its `defaults=` query parameter, URL-decodes
and JSON-parses it, and asserts it is a valid `RuleFormValues` object:

- the required keys `type`, `name`, `condition`, `queries` are present;
- `queries` is a non-empty list;
- `condition` names one of the query `refId`s.

This is the one seam that requires **no live datasource** — the backend only
needs a metrics/logs datasource *UID configured in settings* to render the
template. It is therefore expected to actually **run and PASS**. It catches
Grafana breaking the internal `defaults=` contract, or our URL-encoding
regressing (the frontend hands this URL straight to `/alerting/new`).

**SKIP** when: the endpoint returns `503` (the metrics/logs datasource UID is
not configured in plugin settings) — a config gap, not a contract break.

### 2. nais deploy sync

Deploy markers and regression detection depend on the backend polling the nais
API (Console) with a provisioned token and writing deploy annotations. This
check fetches `/services/{ns}/{svc}/frontend/versions` for a known
recently-deployed service and asserts the response carries deploy-tagged
annotations (a `latestVersion`, or at least one version with a `deployedAtMs`).

The token lives in `secureJsonData` and cannot be detected from outside the
backend, so the check is gated on `EXPECT_DEPLOY_SYNC=1` — set that only when
you know a token is provisioned.

**SKIP** when: `EXPECT_DEPLOY_SYNC` is not `1` (default — "no token expected"),
or the versions endpoint reports `unavailable` (Loki down). It **FAILs** only
when a token is expected, the endpoint answers, yet no deploy annotation is
present — i.e. the sync is genuinely broken.

### 3. Triage actor attribution

Every triage action records *who* performed it. The actor is a real login only
when the request carries a signed-in Grafana user context (a browser session or
a **user** token); a plain basic-auth admin call has no user context and the
backend records `actor="unknown"`. The harness POSTs a triage `resolve` against
a throwaway fingerprint, reads the actor back from the triage history, and:

- **PASS** if the actor is a real login (`≠ "unknown"`);
- **SKIP** if the actor is `"unknown"` — meaning the run had no user session.
  Pass `USER_TOKEN=glsa_…` for a real user to actually exercise this;
- **SKIP** if the triage write itself returns non-200 (e.g. no service-account
  token configured, so the annotation store is not writable).

The check always **cleans up** the annotation it created, deleting it via the
Grafana annotations API by its `fp:` tag. Cleanup is best-effort (needs
annotation-write access) and is reported but never fatal.

### 4. Capabilities sanity

`/capabilities` must answer even when datasources are unreachable — it degrades
to `available:false` flags rather than erroring. The harness asserts the
endpoint returns `200` and that every datasource-reachability flag
(`spanMetrics.detected`, `tempo.available`, `loki.available`, and each
per-environment `tempoByEnv[*]`/`lokiByEnv[*]` entry) is a real boolean. This
distinguishes a total datasource outage (flags go `false`, endpoint still 200)
from an endpoint that has itself fallen over (non-200 / non-boolean).

**SKIP**: none — this check always runs.

## Reading the summary

Each line prints `PASS` / `SKIP` / `FAIL`; the footer prints
`SUMMARY: PASS=… SKIP=… FAIL=…`. A healthy run against an environment without a
nais token or a user session looks like this — note the alert-template and
capabilities contracts run for real while the token/session-gated checks skip
honestly:

```
### 1. alert-template defaults= contract (pdl/pdl-api) ###
  PASS alert-templates/error-rate
  PASS alert-templates/exception-spike
  PASS alert-templates/web-vitals
  PASS alert-templates/new-exceptions
  PASS alert-templates/slo-burn-rate
### 2. nais deploy sync (navno/nav-enonicxp-frontend) ###
  SKIP deploy-sync        no nais API token expected (set EXPECT_DEPLOY_SYNC=1 when provisioned)
### 3. triage actor attribution (pdl/pdl-api) ###
  SKIP triage-actor       actor="unknown" — needs a real user session (set USER_TOKEN)
       cleanup: deleted 1 test annotation(s) for fp=smoketest…
### 4. capabilities sanity ###
  PASS capabilities

 SUMMARY: PASS=6  SKIP=2  FAIL=0
```

A `SKIP` never fails the run — it means "this contract could not be exercised
here". Only a `FAIL` (which exits non-zero) signals a genuine contract break.
