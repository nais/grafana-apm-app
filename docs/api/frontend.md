# Frontend (Faro)

**Stability: experimental.** Shapes may change without a deprecation window.

Browser-telemetry endpoints backed by Faro data in Loki (and Alloy histogram
metrics in Mimir). All are `GET`, all under the resources proxy base
`{GRAFANA_URL}/api/plugins/nais-apm-app/resources`.

Contents:
- [`GET /frontend`](#get-frontend)
- [`GET /frontend/versions`](#get-frontendversions)
- [`GET /frontend/sessions`](#get-frontendsessions)
- [`GET /feedback`](#get-feedback)

All four take the standard `namespace`/`service` path params (service required,
else `400 {"error":"missing or invalid service"}`) and an `environment` query
param (`parseEnvironment`). When Loki is not configured for the resolved
environment they return `200` with `"unavailable": true` instead of an error.
All are cached 30 s (`X-Cache: HIT` on hit).

---

## `GET /frontend`

`GET /services/{namespace}/{service}/frontend`

Aggregate frontend health: p75 web vitals, error rate, and whether Faro/Loki
data exists. Internally uses a fixed 6-hour window (no `from`/`to`).

### Parameters

`namespace`, `service` (path), `environment` (query). No time-range parameters.

### Response — `FrontendMetricsResponse`

| Field | Type | Description |
| --- | --- | --- |
| `available` | bool | Faro/histogram metrics exist for the service. |
| `source` | string? | Metric source, e.g. `"alloy-histogram"`. |
| `vitals` | object? | p75 web vitals map; keys `lcp`, `fcp`, `cls`, `inp`, `ttfb` (numbers). |
| `errorRate` | number | Frontend error rate over 6 h. |
| `hasLoki` | bool? | Loki has Faro data for enrichment. |

### Example

```bash
curl -s ".../services/fager/min-side-arbeidsgiver/frontend"
```

```json
{
  "available": true,
  "source": "alloy-histogram",
  "vitals": { "cls": 0.1, "fcp": 990.54, "inp": 97.5, "lcp": 1565.32, "ttfb": 421.42 },
  "errorRate": 0.0013,
  "hasLoki": true
}
```

---

## `GET /frontend/versions`

`GET /services/{namespace}/{service}/frontend/versions`

Per-version adoption and error-free rate, enriched with deploy annotations.

### Parameters

`namespace`, `service` (path); `environment`, `from`, `to` (query, standard
defaults).

### Response — `FrontendVersionsResponse`

| Field | Type | Description |
| --- | --- | --- |
| `versions` | array&lt;VersionStat&gt; | Up to 20, sorted by sessions desc. |
| `latestVersion` | string? | Version on the newest deploy annotation in range. |
| `unavailable` | bool? | Loki not configured/reachable. |

**VersionStat**:

| Field | Type | Description |
| --- | --- | --- |
| `version` | string | `app_version` tag. |
| `sessions` | number | Distinct sessions on this version. |
| `adoption` | number | Share of all sessions (0–1). |
| `errorFreeRate` | number | `1 − min(errSessions/sessions, 1)` (0–1). |
| `exceptions` | number | Exception occurrences on this version. |
| `deployedAtMs` | int64? | Earliest deploy-annotation timestamp (epoch ms). |

### Example

```bash
curl -s ".../services/fager/min-side-arbeidsgiver/frontend/versions?from=1783090000&to=1783185000"
```

```json
{
  "versions": [
    { "version": "fc89e5cfff95a8375e22b0f0cbabe7dd86fcd2f4", "sessions": 1238, "adoption": 0.6087, "errorFreeRate": 0.9685, "exceptions": 47 },
    { "version": "5448e74f7b748c8930e976d7ef1c89723ca23676", "sessions": 792,  "adoption": 0.3894, "errorFreeRate": 0.9432, "exceptions": 61 }
  ]
}
```

---

## `GET /frontend/sessions`

`GET /services/{namespace}/{service}/frontend/sessions`

Recent browser sessions with per-session event/error counts and user-agent
metadata.

### Parameters

`namespace`, `service` (path); `environment`, `from`, `to` (query); plus:

| Name | Sanitization | Meaning |
| --- | --- | --- |
| `q` | trimmed, lower-cased substring (not label-sanitized) | Free-text filter over sessionId / userId / userEmail. |

### Response — `FrontendSessionsResponse`

| Field | Type | Description |
| --- | --- | --- |
| `sessions` | array&lt;SessionSummary&gt; | Up to 50, sorted by errors desc. |
| `truncated` | bool | More sessions matched than the cap. |
| `unavailable` | bool | Loki not configured/reachable. |
| `windowSeconds` | int? | Narrowed effective window when the fallback ladder was used. |

**SessionSummary**:

| Field | Type | Description |
| --- | --- | --- |
| `sessionId` | string | Faro session id. |
| `firstSeenMs` / `lastSeenMs` | int64 | Activity bounds (epoch ms). |
| `events` | number | Total Faro lines for the session. |
| `errors` | number | Exception count. |
| `userId` / `userEmail` | string | User identity (may be empty). |
| `browser` / `os` | string | User-agent details. |
| `appVersion` | string | App version for the session. |
| `pages` | int | Distinct page URLs seen. |

### Example

```bash
curl -s ".../services/fager/min-side-arbeidsgiver/frontend/sessions?from=1783090000&to=1783185000"
```

```json
{
  "sessions": [
    {
      "sessionId": "S2mTgLbmgT",
      "firstSeenMs": 1783106481228,
      "lastSeenMs": 1783106496516,
      "events": 121,
      "errors": 6,
      "userId": "",
      "userEmail": "",
      "browser": "Chrome",
      "os": "Mac OS 10.15.7",
      "appVersion": "5448e74f7b748c8930e976d7ef1c89723ca23676",
      "pages": 1
    }
  ],
  "truncated": false,
  "unavailable": false
}
```

> The `q` filter and the `userEmail`/`userId` fields can expose end-user
> identifiers. Scrub them before republishing session data.

---

## `GET /feedback`

`GET /services/{namespace}/{service}/feedback`

User feedback events (`faro.feedback`) captured by the `@nais/apm` client.

### Parameters

`namespace`, `service` (path); `environment`, `from`, `to` (query); plus:

| Name | Sanitization | Meaning |
| --- | --- | --- |
| `sessionId` | `[A-Za-z0-9-_]` (`sanitizeSessionID`) | Filter to one session. |
| `fingerprint` | `[A-Za-z0-9-_:]` (`sanitizeFingerprintFilter`) | Filter to feedback tied to an issue fingerprint. |

### Response — `FeedbackResponse`

| Field | Type | Description |
| --- | --- | --- |
| `feedback` | array&lt;FeedbackEntry&gt; | Up to 200, newest first. |
| `unavailable` | bool? | Loki not configured/reachable or query failed. |

**FeedbackEntry**:

| Field | Type | Description |
| --- | --- | --- |
| `timeMs` | int64 | Event time (epoch ms). |
| `message` | string | Feedback message. |
| `category` | string | Feedback category. |
| `email` | string? | Submitter email. |
| `sessionId` | string? | Session id. |
| `fingerprint` | string? | Associated issue fingerprint. |
| `pageUrl` | string? | Page the feedback came from. |
| `appVersion` | string? | App version. |

### Example

```bash
curl -s ".../services/fager/min-side-arbeidsgiver/feedback?from=1783090000&to=1783185000"
```

```json
{ "feedback": [] }
```

> Feedback entries commonly contain free-text and an `email`. Treat as PII.
