# Issues, exceptions & triage

**Stability: stable.** These endpoints carry the additive-only compatibility
promise (see [README](./README.md#stability-contract)).

All paths are under the resources proxy base
`{GRAFANA_URL}/api/plugins/nais-apm-app/resources`. Examples use
`admin:admin` basic auth against a local Grafana; in automation send
`Authorization: Bearer $GRAFANA_SA_TOKEN` instead.

Contents:
- [`GET /issues`](#get-issues)
- [`GET /exceptions/groups`](#get-exceptionsgroups)
- [`GET /triage`](#get-triage)
- [`POST /triage/{fingerprint}`](#post-triagefingerprint)
- [`GET /triage/{fingerprint}/history`](#get-triagefingerprinthistory)

---

## `GET /issues`

`GET /services/{namespace}/{service}/issues`

The merged, fingerprint-grouped issue list for a service, combining **browser**
exceptions (Faro, via Loki) and **server** log errors. This is the endpoint CI
gates and bots read.

### Parameters

| In | Name | Sanitization / default | Meaning |
| --- | --- | --- | --- |
| path | `namespace` | `ParseNamespace` (`_` → empty) | Team namespace. |
| path | `service` | `MustSanitizeLabel`; empty → `400` | Service (app) name. |
| query | `environment` | `parseEnvironment` (CSV, each `MustSanitizeLabel`) | Filter to one or more environments, e.g. `prod` or `prod,prod-fss`. |
| query | `from` | epoch seconds, default `now-1h` | Range start. |
| query | `to` | epoch seconds, default `now` | Range end. |
| query | `version` | `MustSanitizeLabel` of trimmed value | Facet: restrict to a browser app version. |
| query | `browser` | `MustSanitizeLabel` | Facet: restrict to a browser. |
| query | `page` | `MustSanitizeLabel` | Facet: restrict to a page URL. |

When any of `version`/`browser`/`page` is set, the list is scoped to **browser**
telemetry only (server side is skipped) and `facetedSource` is `"browser"`.

### Response — `IssuesResponse`

| Field | Type | Description |
| --- | --- | --- |
| `fingerprintVersion` | string | Fingerprint algorithm version (`"v1"`). |
| `sources` | object | Which sides answered: `{ "browser": bool, "serverLogs": bool }`. |
| `issues` | array&lt;Issue&gt; | Merged issues, sorted by `count` desc, capped at 100. |
| `facets` | object? | Discoverable browser facet values (omitted when Faro unavailable). |
| `facetedSource` | string? | `"browser"` when a facet is active. |
| `sessionsWindowSeconds` | int? | Narrower window used for session counts (fallback). |
| `sessionsUnavailable` | bool? | Session counts could not be computed. |
| `unavailable` | bool? | Loki not configured, or both sides failed. |

**Issue** (a browser or server issue):

| Field | Type | Description |
| --- | --- | --- |
| `fingerprint` | string | Versioned fingerprint id, e.g. `v1:bb2cfdb1eb952653`. |
| `tier` | int | Fingerprint precision tier (higher = more specific). |
| `title` | string | Normalized human title. |
| `types` | array&lt;string&gt; | Exception types in the group (omitted if empty). |
| `count` | number | Occurrences in range. |
| `sessions` | number | Affected sessions. |
| `memberHashes` | array&lt;string&gt; | Upstream Alloy hashes (browser only, cap 50). |
| `truncated` | bool? | Member-hash cap hit. |
| `source` | string | `"browser"` or `"server"`. |
| `impact` | object? | Server issues only: `{ "pods": int, "versions": [] }`. |

**facets** (`IssueFacets`) — each list is capped at 15 values:

| Field | Type | Description |
| --- | --- | --- |
| `versions` | array&lt;{value,count}&gt; | Top app versions. |
| `browsers` | array&lt;{value,count}&gt; | Top browsers. |
| `topPages` | array&lt;{value,count}&gt; | Top page URLs. |

### Caching

Cached (30 s). Key includes org id, namespace, service, environment, the 30 s
rounded `from`/`to`, and the three facet values. `X-Cache: HIT` on hit.

### Example

```bash
curl -s "http://admin:admin@localhost:3000/api/plugins/nais-apm-app/resources/services/fager/min-side-arbeidsgiver/issues?from=1783090000&to=1783185000"
```

```json
{
  "fingerprintVersion": "v1",
  "sources": { "browser": true, "serverLogs": true },
  "issues": [
    {
      "fingerprint": "v1:bb2cfdb1eb952653",
      "tier": 2,
      "title": "Error: Load failed",
      "types": ["Error"],
      "count": 31,
      "sessions": 30,
      "memberHashes": ["3664508321076063859"],
      "source": "browser"
    }
  ],
  "facets": {
    "versions": [
      { "value": "5448e74f7b748c8930e976d7ef1c89723ca23676", "count": 61 },
      { "value": "fc89e5cfff95a8375e22b0f0cbabe7dd86fcd2f4", "count": 47 }
    ],
    "browsers": [
      { "value": "Mobile Safari", "count": 33 },
      { "value": "Chrome", "count": 30 }
    ],
    "topPages": []
  }
}
```

---

## `GET /exceptions/groups`

`GET /services/{namespace}/{service}/exceptions/groups`

Fingerprint-grouped **frontend** (Faro) exceptions only — the browser subset of
`/issues`, without the server-log merge or facets. Useful when you only care
about browser errors.

### Parameters

`namespace`, `service` (path), `environment`, `from`, `to` (query) — identical
semantics to `/issues`. No facet parameters.

### Response — `ExceptionGroupsResponse`

| Field | Type | Description |
| --- | --- | --- |
| `fingerprintVersion` | string | `"v1"`. |
| `groups` | array&lt;ExceptionGroup&gt; | Sorted by `count` desc, capped at 100. |
| `unavailable` | bool? | Loki not configured/reachable, or count query failed. |
| `sessionsWindowSeconds` | int? | Narrower window used for session counts. |
| `sessionsUnavailable` | bool? | Session counts unavailable even after fallback. |

**ExceptionGroup** — same fields as the shared subset of `Issue`:
`fingerprint`, `tier`, `title`, `types`, `count`, `sessions`, `memberHashes`,
`truncated`.

### Caching

Cached (30 s), key `exceptiongroups | org | namespace | service | env | from | to`.

### Example

```bash
curl -s ".../services/fager/min-side-arbeidsgiver/exceptions/groups?from=1783090000&to=1783185000"
```

```json
{
  "fingerprintVersion": "v1",
  "groups": [
    {
      "fingerprint": "v1:bb2cfdb1eb952653",
      "tier": 2,
      "title": "Error: Load failed",
      "types": ["Error"],
      "count": 31,
      "sessions": 30,
      "memberHashes": ["3664508321076063859"]
    }
  ]
}
```

---

## `GET /triage`

`GET /services/{namespace}/{service}/triage`

The current, folded triage state for every fingerprint that has ever been
triaged for this service. State is reconstructed newest-wins from a
Grafana-annotation event log. **Never cached.**

### Parameters

`namespace`, `service` (path). No query parameters.

### Response — `triageStatesResponse`

| Field | Type | Description |
| --- | --- | --- |
| `states` | object | Map of `fingerprint` → `TriageState`. |

**TriageState**:

| Field | Type | Description |
| --- | --- | --- |
| `status` | string | `active` \| `resolved` \| `ignored`. |
| `assignee` | string? | Current assignee login. |
| `resolvedInVersion` | string? | Version the issue was resolved in. |
| `updatedAt` | int64 | Last state-change time (epoch ms). |
| `updatedBy` | string | Actor login of the last change. |

### Example

```bash
curl -s ".../services/fager/min-side-arbeidsgiver/triage"
```

```json
{
  "states": {
    "v1:bb2cfdb1eb952653": {
      "status": "resolved",
      "resolvedInVersion": "fc89e5cf",
      "updatedAt": 1783181707398,
      "updatedBy": "unknown"
    }
  }
}
```

`502 {"error":"reading triage state failed"}` if the annotation store errors.

---

## `POST /triage/{fingerprint}`

`POST /services/{namespace}/{service}/triage/{fingerprint}`

Record a triage action. Appends an event to the Grafana-annotation log and
returns the newly folded state. **The only write endpoint in the API.** Requires
a credential with annotation-write (Editor). **Never cached.**

### Parameters

| In | Name | Sanitization | Meaning |
| --- | --- | --- | --- |
| path | `namespace`, `service` | as above | Service reference. |
| path | `fingerprint` | must match `^[a-z0-9:]{1,64}$`; else `400 {"error":"invalid fingerprint"}` | Issue fingerprint, e.g. `v1:bb2cfdb1eb952653`. |

### Request body — `triageActionRequest` (max 16 KiB)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string | yes | `resolve` \| `ignore` \| `unresolve` \| `assign`. |
| `assignee` | string | no | Login to assign to (with `assign`). |
| `resolvedInVersion` | string | no | Version fixed in (with `resolve`). |
| `note` | string | no | Free-text note stored in the event log. |

An unknown/absent `action` or an undecodable body returns
`400 {"error":"invalid action"}`.

### Response

The single folded `TriageState` for this fingerprint (same shape as under
`/triage`).

### Example

```bash
curl -s -X POST \
  ".../services/fager/min-side-arbeidsgiver/triage/v1:bb2cfdb1eb952653" \
  -H 'Content-Type: application/json' \
  -d '{"action":"resolve","resolvedInVersion":"fc89e5cf","note":"fixed in latest deploy"}'
```

```json
{
  "status": "resolved",
  "resolvedInVersion": "fc89e5cf",
  "updatedAt": 1783181707398,
  "updatedBy": "unknown"
}
```

Errors: `405 {"error":"method not allowed"}` (non-POST),
`400 {"error":"invalid fingerprint"}`, `400 {"error":"invalid action"}`,
`502 {"error":"recording triage action failed"}`.

---

## `GET /triage/{fingerprint}/history`

`GET /services/{namespace}/{service}/triage/{fingerprint}/history`

The full triage event log for one fingerprint, oldest-first. **Never cached.**

### Parameters

`namespace`, `service`, `fingerprint` (path, same `^[a-z0-9:]{1,64}$` rule).

### Response

A JSON object `{ "events": [ TriageEvent ] }`.

**TriageEvent**:

| Field | Type | Description |
| --- | --- | --- |
| `schema` | int | Event schema version (`1`). |
| `action` | string | `resolve` \| `ignore` \| `unresolve` \| `assign`. |
| `actor` | string | Who performed it. |
| `assignee` | string? | Assignee (assign action). |
| `resolvedInVersion` | string? | Version (resolve action). |
| `note` | string? | Note. |
| `timeMs` | int64 | Event time (epoch ms). |

### Example

```bash
curl -s ".../services/fager/min-side-arbeidsgiver/triage/v1:bb2cfdb1eb952653/history"
```

```json
{
  "events": [
    {
      "schema": 1,
      "action": "resolve",
      "actor": "unknown",
      "resolvedInVersion": "fc89e5cf",
      "note": "fixed in latest deploy",
      "timeMs": 1783181707398
    }
  ]
}
```

`502 {"error":"reading triage history failed"}` on store error.
