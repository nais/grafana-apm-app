# navikt frontend observability audit: Faro & Sentry

Read-only research audit of how `github.com/navikt` applications instrument their
frontends today (Grafana Faro and Sentry), to inform the `@nais/apm` adoption /
migration story. No code was changed. Date: 2026-07-04/05.

---

## Method & limits (read this first)

- **Tooling**: `gh search code` and `gh api search/code` against `org:navikt`,
  plus `gh api repos/.../contents` and `.../git/trees` to read real init files.
- **Auth**: token belongs to an org member (scopes `repo`, `read:org`), so GitHub
  code search **includes private navikt repos** the account can see. Counts below
  therefore span public + accessible-private code.
- **Hard limits hit**:
  - Code search is rate-limited to **10 requests/minute**; I hit `403 rate limit
    exceeded` twice and paced around it. Some planned queries were dropped.
  - Code search **caps results at 100 per query** and sorts by relevance, so
    per-repo dedup counts below are **lower bounds** (sampled from the top 100),
    not exhaustive.
  - `total_count` from the search API counts **matching files, not repos**. A
    monorepo can contribute several files; lockfiles inflate transitive-dep hits.
- **Confidence**: pattern findings (init shape, collector URLs, PII scrubbing)
  come from reading actual source files and are high-confidence. Absolute repo
  counts are directional; treat them as "at least N".

---

## Headline numbers

| Signal (org:navikt) | Files matched (`total_count`) | Notes |
|---|---|---|
| `@grafana/faro-web-sdk` | **382** | code + config refs |
| `faro-web-sdk` in `package.json` (`extension:json`) | **147** | ≈ one per app → **~140+ apps depend on Faro** |
| `initializeFaro` | 159 | actual init call sites |
| `getWebInstrumentations` | 104 | |
| `@grafana/faro-web-tracing` (TracingInstrumentation) | 165 | tracing widely added |
| `@grafana/faro-react` (ReactIntegration) | 85 | React-router-aware Faro |
| `telemetry.nav.no/collect` | 147 | the nais collector URL, hardcoded/referenced |
| `NEXT_PUBLIC_TELEMETRY_URL` | 98 | Next.js Faro apps |
| `beforeSend` alongside `faro-web-sdk` | 18 | apps doing custom Faro scrubbing (minority) |
| `faro-web-sdk` + `setUser` | 2 | Faro apps almost never set user identity |
| — | — | — |
| `@sentry/browser` | 143 | often transitive; 31 repos sampled |
| `@sentry/react` | 113 | 24 repos sampled |
| `@sentry/react` in `package.json` | 37 | direct dependents |
| `@sentry/nextjs` | 39 | 5 repos sampled |
| `Sentry.init` | 44 | init call sites |
| `Sentry.init` + `@sentry/nextjs` | 11 | |
| `@sentry/cli` | 27 | source-map upload tooling |
| `Sentry.setUser` | 7 | identity capture (PII risk) |
| `sentry.gc.nav.no` | **160** | **self-hosted Sentry** DSN host |
| — | — | — |
| `@navikt/next-logger` | **848** | widely-used shared NAV logging lib |
| `@navikt/faro` | **0** | **no published shared Faro wrapper exists** |

**Repo dedup (sampled, top-100 per query — lower bounds):**
- Faro: **≥115 unique repos** (union of `@grafana/faro-web-sdk` and
  `faro-web-sdk` package.json searches).
- Sentry: **≥42 unique repos** (union of react/browser/nextjs searches).
- **Faro ∩ Sentry: 14 repos** run both simultaneously (see migration section).

---

## 1. Faro adoption

Faro is the **dominant, de-facto standard** for navikt frontend observability
(~140+ apps depend on it vs. ~40 for Sentry). It maps directly onto the nais
frontend-telemetry offering.

**Init pattern**: overwhelmingly **raw `initializeFaro({...})` in a per-app
`faro.ts` / `initFaro.ts` / `observability.ts` helper** — there is *no* shared
published package; every team hand-rolls the same ~30 lines. Common shape:

```ts
initializeFaro({
  url,                       // collector, chosen at runtime by hostname
  app: { name, namespace?, version },
  paused: hostname === 'localhost',
  instrumentations: [...getWebInstrumentations({ captureConsole: false })],
  metas: [customPageMeta],   // often URL masking (PII)
  beforeSend,                // sometimes; error filtering / PII
});
```

**App identity**: apps consistently set `app.name` (must match `metadata.name`
in `naiserator.yaml`), sometimes `app.namespace`, and `app.version` from the
image tag / a release env var. Notably several Faro apps still read the version
from **`VITE_SENTRY_RELEASE`** (e.g. `foreldrepengesoknad`) — a leftover of the
Sentry release tooling, a tell that they migrated Sentry→Faro.

**Collector URL — a rock-solid convention** (nais auto-config, per
`docs.nais.io/observability/frontend`):
- prod: `https://telemetry.nav.no/collect`
- dev:  `https://telemetry.ekstern.dev.nav.no/collect`
- local: paused, or `http://localhost:12347`
Runtime selection is by `location.hostname.endsWith('dev.nav.no')` or an
`erProd()/erPreprod()` env helper. `telemetry.nav.no/collect` appears in **147**
files.

**Shared helper?** No org-wide published one (`@navikt/faro` → 0 hits). The
closest is an **internal monorepo-local package**: `navikt/foreldrepengesoknad`
`packages/observability/src/initFaro.ts`, a well-built wrapper (typed
`{app:{name,namespace}}`, dev/prod URL switch, `beforeSend` exception filtering,
query-param masking) — but it is not consumed outside that monorepo.

**Concrete Faro examples**:
- `navikt/foreldrepengesoknad` — `packages/observability` shared internal wrapper, best-in-class.
- `navikt/modiapersonoversikt` — `@grafana/faro-react` + `ReactIntegration`, masks 11-digit fnr in URLs (`ignoreUrls: [/\d{11}/]`).
- `navikt/sykepengesoknad-frontend` — env-driven (`naisAppName()`, `naisAppImage()`, `telemetryCollectorURL()`), pino→Faro log-level bridge.
- `navikt/oppfolgingsplan-frontend` — Next.js, `NEXT_PUBLIC_TELEMETRY_URL`, adds `TracingInstrumentation`.
- `navikt/familie-ba-sak-frontend` — Vite, `erProd/erPreprod` URL switch, `isolate:true`, try/catch around init.

---

## 2. Sentry adoption

Sentry is the **legacy / secondary** stack (~40 repos), and it is **self-hosted**:
DSNs point at **`sentry.gc.nav.no`** (160 file refs; e.g. `send-inn-frontend`
hardcodes `https://…@sentry.gc.nav.no/153`). No evidence of `sentry.io` SaaS.
DSNs come from `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_DSN`.

**Framework spread inside Sentry**: mix of `@sentry/react` (Vite/CRA SPAs, e.g.
`aktivitetsplan`) and `@sentry/nextjs` (e.g. `pam-stillingsok`,
`send-inn-frontend`). Modern Next.js uses the new **`instrumentation-client.ts`**
convention (`pam-stillingsok`), older ones use `sentry.client.config.js` +
`sentry.server.config.js`.

**What they capture**: errors + tracing (`tracesSampleRate` 0.1–1.0),
`captureConsoleIntegration`, `httpClientIntegration`,
`reactRouterV6BrowserTracingIntegration`, `thirdPartyErrorFilterIntegration`
(filter to own app frames). Release + **source maps via `@sentry/cli`** (27 files;
`SENTRY_RELEASE` env), e.g. `tiltaksgjennomforing/sentry.js` runs
`cli.releases.uploadSourceMaps`.

**Concrete Sentry examples**:
- `navikt/pam-stillingsok` — Next.js `instrumentation-client.ts`, `@sentry/nextjs`, `thirdPartyErrorFilterIntegration`, `allowUrls`.
- `navikt/send-inn-frontend` — Next.js `sentry.client/server.config.js`, DSN → `sentry.gc.nav.no`.
- `navikt/aktivitetsplan` — `@sentry/react`, react-router v6 tracing, **fnr masking** in `beforeSend`.
- `navikt/tiltaksgjennomforing` — `@sentry/cli` source-map upload script.

---

## 3. Framework spread

Exact percentages weren't feasible within the search rate cap; this is a
qualitative split from init-file conventions + env-var signals:

- **Next.js**: large and growing. Signals: `NEXT_PUBLIC_TELEMETRY_URL` (98 Faro
  files), `@sentry/nextjs` (39), `_app.tsx`/`instrumentation-client.ts` init
  sites. Both Faro and Sentry Next.js apps exist. **Modern App-Router
  `instrumentation-client.ts` is still nascent — only 2 hits** (`pam-stillingsok`
  et al.); most Next.js apps still init in `_app.tsx` or `sentry.client.config`.
- **Vite / CRA React SPA**: also large. Init in `src/index.tsx`, `main.tsx`,
  `App.tsx`; `import.meta.env` / `VITE_*` env; `@grafana/faro-react`
  `ReactIntegration` for router awareness. Examples: `sykepengesoknad-frontend`,
  `familie-ba-sak-frontend`, `modiapersonoversikt`, `min-side-arbeidsgiver`,
  `team-catalog`, `aktivitetsplan`, `personopplysninger`.
- **Remix**: rare — `navikt/orb` (`entry.client.tsx`). No meaningful Svelte
  observability signal found.

Takeaway: **React is universal; the real axis is Next.js vs Vite-SPA**, and both
populations are big enough to matter for `@nais/apm`.

---

## 4. PII patterns

- **Norwegian fnr (11-digit) masking is the recurring PII concern**, handled
  the same way in both stacks: a `/\d{11}/g` / `/[0-9]{11}/g` regex that replaces
  matches with `<fnr>` / `***********`, applied to URLs and error text.
  - Faro: `modiapersonoversikt` (`customPageMeta` + `ignoreUrls:[/\d{11}/]`),
    `foreldrepengesoknad` (query-param masking in `customPageMeta`).
  - Sentry: `aktivitetsplan` (`maskerPersonopplysninger` in `beforeSend`,
    masks fnr in message, tags.transaction, breadcrumbs).
- **Faro apps almost never set user identity**: `faro-web-sdk`+`setUser` = **2
  files**; `faro.api.setUser` = 0. The nais Faro path is privacy-conservative by
  default.
- **Sentry does capture identity in a few apps**: `Sentry.setUser` = **7 files**
  — the main place emails/idents could leak.
- **Custom scrubbing is a minority effort**: only **18** Faro apps use a
  `beforeSend`; the other ~120 rely on defaults + URL-meta masking. This is
  exactly the gap a guarded SDK should close.

**Validation for `@nais/apm`'s PII-guard direction**: strongly supported. Teams
clearly want fnr scrubbing but reimplement it ad hoc (and inconsistently — only a
minority do it at all). A built-in fnr/PII scrubber and a no-identity-by-default
posture match observed intent.

---

## 5. Existing conventions

- **Shared-lib culture exists and works**: `@navikt/next-logger` is imported in
  **848** files — proof that navikt teams will adopt a well-packaged shared
  `@navikt/@nais` observability lib from GHPR. There just isn't one for Faro yet.
- **Collector URLs** (`telemetry.nav.no/collect` /
  `telemetry.ekstern.dev.nav.no/collect`) and the **dev/prod hostname switch**
  are already a hard convention — `@nais/apm` should encode these as defaults so
  apps stop hand-writing them.
- **App metadata** convention: `app.name` == `naiserator.yaml metadata.name`,
  optional `namespace`, `version` from image tag — some via `naisAppName()` /
  `naisAppImage()` env helpers, some hardcoded strings.
- **Source maps**: Sentry side uses `@sentry/cli` + `SENTRY_RELEASE` (27 files).
  Faro side has no comparable standardized upload story in what was sampled —
  relevant to the memory note about `cdn.nav.no` source maps.
- **No published shared Faro/observability package** (`@navikt/faro` = 0). The
  only reuse is monorepo-internal (`foreldrepengesoknad/packages/observability`).

---

## 6. Migration surface & friction

**Surface**: roughly **~140+ Faro apps** already on the nais collector (these are
"re-wrap the same 30 lines" migrations — low risk) plus **~40 Sentry apps**, of
which **14 run Faro *and* Sentry today** (`familie-*`, `k9-*`, `sif-brukerdialog`,
`gosys-oppgavebehandling`, `foreldrepengesoknad`, `arbeidsrettet-dialog`,
`farskapsportal-ui`) — these are mid-migration and the prime `@nais/apm` targets.

**Biggest frictions, in order:**
1. **Next.js init timing / App Router.** The modern `instrumentation-client.ts`
   convention is barely adopted (2 hits); most Next.js apps still init in
   `_app.tsx` or `sentry.client.config`. `@nais/apm` must ship a clear Next.js
   story (a client-instrumentation entry) or migrations stall.
2. **Source maps.** Sentry teams have a `@sentry/cli` + `SENTRY_RELEASE` upload
   habit (27 files) with no Faro equivalent. Moving off Sentry loses readable
   stack traces unless `@nais/apm` provides a source-map upload path
   (cdn.nav.no per the direction notes).
3. **PII expectations.** Teams that scrub fnr today (Faro `beforeSend`, Sentry
   `beforeSend`, URL metas) will not adopt anything that regresses that. The
   guard must be on by default and cover the fnr/11-digit case.
4. **GHPR read-token.** Consuming a private `@nais/*` package from GitHub
   Packages needs the read token wired into every app's CI + local install —
   the same friction `@navikt/next-logger` consumers already solved, so there's
   a proven path, but it's still per-repo setup.
5. **Version/identity plumbing drift.** Version is sourced inconsistently
   (`VITE_SENTRY_RELEASE`, image tag, `NEXT_PUBLIC_*`); a wrapper that reads a
   single nais-provided value removes bespoke glue.

---

## Recommendations for `@nais/apm` (falling out of the data)

1. **Ship framework-specific entrypoints — `@nais/apm/react` (Vite/CRA) and a
   Next.js client-instrumentation helper.** React is universal but the field
   splits Vite-SPA vs Next.js, and the Next.js `instrumentation-client.ts`
   convention is under-adopted (2 hits) precisely because it's fiddly. Own that
   timing for teams.
2. **Bake in the collector convention.** Default to
   `telemetry.nav.no/collect` (prod) / `telemetry.ekstern.dev.nav.no/collect`
   (dev) with the hostname switch and `paused` on localhost. ~140 apps hand-write
   this today; make it zero-config.
3. **PII guard on by default, fnr-aware.** Built-in scrubbing of Norwegian fnr
   (`\d{11}`) and query-param masking, and **no `setUser`/identity by default**.
   This matches what the careful teams already do and fixes the ~120 that do
   nothing. Make opt-in identity explicit and guarded.
4. **Provide a source-map upload path.** Match the Sentry `@sentry/cli` habit
   with a Faro/nais source-map upload to cdn.nav.no so Sentry→`@nais/apm`
   migrations don't lose readable stack traces — this is the #2 friction.
5. **Package it like `@navikt/next-logger` and target the 14 dual-stack repos
   first.** The 848-file adoption of `next-logger` proves the GHPR shared-lib
   model works; the `familie-*` / `k9-*` / `sif` apps already run Faro+Sentry and
   feel the double-maintenance pain — they're the fastest, highest-signal
   wins and good design partners. Read `app.name/namespace/version` from a single
   nais-provided source to kill the `VITE_SENTRY_RELEASE`-style glue.

---

### Appendix — sampled repos

**Faro (≥115 sampled)**: foreldrepengesoknad, sykepengesoknad-frontend,
modiapersonoversikt, familie-ba-sak-frontend, oppfolgingsplan-frontend,
min-side-arbeidsgiver, min-ia, syfomodiaperson, syfooversikt, arbeidsrettet-dialog,
farskapsportal-ui, fia-arbeidsgiver-frontend, permittering, team-catalog,
personopplysninger, din-uforetrygd, sosialhjelp-soknad, veilarbportefoljeflatefs,
copilot, nav-enonicxp-frontend, k9-inntektsmelding-frontend, samisk-samtale-bestilling,
orb (Remix), … (list capped at top-100 per query).

**Sentry (≥42 sampled)**: aksel, aktivitetsplan, arbeidsrettet-dialog,
familie-ba-sak-frontend, familie-ba-soknad, familie-ef-sak-frontend,
familie-klage-frontend, familie-ks-sak-frontend, familie-tilbake-frontend,
farskapsportal-ui, foreldrepengesoknad, fp-frontend, gosys-oppgavebehandling,
hm-soknad, k9-inntektsmelding-frontend, k9-los-web, k9-punsj-frontend, k9-sak-web,
pam-stillingsok, pam-stillingsregistrering, send-inn-frontend, sif-brukerdialog,
tiltaksgjennomforing, tilleggsstonader-soknad, veilarbpersonflatefs, …

**Faro ∩ Sentry (14)**: arbeidsrettet-dialog, familie-ba-sak-frontend,
familie-ba-soknad, familie-klage-frontend, familie-ks-sak-frontend,
familie-ks-soknad, familie-tilbake-frontend, farskapsportal-ui, foreldrepengesoknad,
gosys-oppgavebehandling, k9-inntektsmelding-frontend, k9-los-web, k9-punsj-frontend,
sif-brukerdialog.
