# Multi-tenancy assumptions in Nais APM

Nais APM is currently installed for the **nav tenant only**. Nothing here
proposes a multi-tenant rollout — it's an inventory of the places the code,
config, and docs currently hardcode the `nav.no` domain, so that whoever picks
up another tenant's install knows what to change first. It is a note, not a
design doc.

## Principle

The correct, tenant-agnostic path is **platform injection**: the nais platform
sets a `<meta name="nais-telemetry-url">` tag (or the equivalent build-time
env var) on every app it serves, and `@nais/apm` reads that value with the
highest priority. That path already works for any tenant with no code change.

The hardcoded `nav.no` values below only exist as a **last-resort fallback or
as documentation examples** for the case where the meta tag/env isn't present
(e.g. a misconfigured deploy). They are nav-only assumptions and must become
tenant-aware — or be dropped in favor of always requiring injection — before
Nais APM ships to a tenant other than nav.

## Inventory

### 1. SDK fallback — `apm-client/src/config.ts`

`telemetryUrlFromCluster()` derives a collector URL from the cluster name as
the last-resort fallback (priority 4, below explicit options, the meta tag,
and env vars):

```ts
function telemetryUrlFromCluster(cluster: string | undefined): string | undefined {
  if (!cluster) return undefined;
  if (cluster.startsWith('prod-')) return 'https://telemetry.nav.no/collect';
  if (cluster.startsWith('dev-')) return 'https://telemetry.ekstern.dev.nav.no/collect';
  return undefined;
}
```

This hardcodes the nav tenant's collector domain. It is kept as-is (nav is the
only tenant today, and removing it would regress zero-config apps that
currently rely on it) but is now commented in code as a nav-specific
assumption. Before another tenant installs Nais APM, this function needs to
either:

- become tenant-aware (resolve the tenant, e.g. from another meta tag/env var,
  and map `cluster` + `tenant` → collector URL), or
- be removed in favor of requiring the platform-injected meta tag/env on every
  tenant (the primary path already covers this — the fallback only exists for
  belt-and-braces).

### 2. Helm chart — source-map CDN (`helm-charts/`, noted, not edited)

`helm-charts/features/alloy-faro/templates/config.yaml` hardcodes the
source-map download origin:

```
download_from_origins = ["https://cdn.nav.no"]
```

and `helm-charts/features/alloy-faro/templates/fqdn-netpol-sourcemaps.yaml`
hardcodes the matching egress allow-list entry:

```yaml
to:
  - fqdns:
      - "cdn.nav.no"
```

Both are nav-specific. Notably, the same chart's `Feature.yaml` already
templates the **collector ingress hostname** by tenant:

```
template: '"{{ or .Configs.ingress.hostOverride "telemetry" }}.external.{{ .Env.name }}.{{ .Tenant.Name }}.cloud.nais.io"'
```

so the precedent for templating by `.Tenant.Name` exists in this chart
already — the source-map CDN origin and its network policy just haven't been
brought in line with it yet. This is nav's live config and is correct for nav
today, so it is **noted only, not edited** here.

### 3. Doc examples — `nais-doc`

Within the Nais APM doc set (`docs/observability/apm/`), one page hardcoded
the nav collector URL in example code:
`docs/observability/apm/reference/apm-client-api.md` (an `init()` example and
a `<meta name="nais-telemetry-url">` example, both showing
`https://telemetry.nav.no/collect`). These have been reworded to state that
the collector URL resolves automatically on nais rather than presenting the
nav domain as *the* URL — see the nais-doc commit for the exact diff.

The wider `nais-doc` repo also has many nav.no/cdn.nav.no references outside
the APM doc set (auth, workloads, CDN, logging docs, etc.). Those are
out of scope here — they predate APM and aren't part of the Nais APM
documentation; this note only tracks the APM-specific ones.

## What must change before another tenant onboards

1. Make `telemetryUrlFromCluster()` in `apm-client/src/config.ts`
   tenant-aware (or retire it in favor of mandatory injection).
2. Template the source-map CDN origin and its network policy in
   `helm-charts/features/alloy-faro/` by `.Tenant.Name`, matching the
   existing ingress-hostname pattern in `Feature.yaml`.
3. Re-check `nais-doc`'s APM doc set for any new nav-only examples introduced
   since this note was written.

No other multi-tenant work (per-tenant config, tenant selection UI, etc.) is
in scope — Nais APM remains a nav-only install until a second tenant is
explicitly onboarded.
