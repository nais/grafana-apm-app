# @nais/apm

> **MOVED.** `@nais/apm` now lives at [github.com/nais/apm](https://github.com/nais/apm) and is published from there. This copy is **frozen** (no further changes) and will be removed from this repository once the package has its first published release — see that repository for the current source, README, and issue tracker.

Opinionated wrapper around [`@grafana/faro-web-sdk`](https://github.com/grafana/faro-web-sdk) with a Sentry-like developer experience for frontend applications on [nais](https://nais.io). Works against self-hosted Grafana LGTM (Alloy `faro.receiver` → Loki/Tempo/Mimir).

> **Status: Phase 0, pre-release.** This package currently lives inside the `grafana-apm-app` repository and will move to its own repository before publishing. The `@nais` npm scope must be claimed before the first publish (see nais/grafana-apm-app#59).

## Quickstart

```ts
// main.tsx — the whole zero-config story
import { init } from '@nais/apm';

init(); // app name, version, environment and collector URL resolved from nais
```

```ts
// Sentry-style usage anywhere in your app
import { captureException, captureMessage, setUser, setContext } from '@nais/apm';

try {
  await save(form);
} catch (e) {
  captureException(e, { context: { form: 'soknad-step-2' } });
}

captureMessage('fallback flow used', 'warning');
setUser({ id: hashedSubject });
setContext('feature', { nyDagpengeflyt: 'variant-b' });
```

## Migrating from Sentry

| `@sentry/react` / `@sentry/browser` | `@nais/apm` | Notes |
| --- | --- | --- |
| `Sentry.init({ dsn, release, environment })` | `init()` | dsn/release/environment resolve automatically on nais |
| `Sentry.captureException(err, { extra })` | `captureException(err, { context })` | No event ID is returned (Faro limitation) |
| `Sentry.captureException(err, { fingerprint })` | `captureException(err, { fingerprint })` | Mapped to `context.fingerprint`, consumed by the Nais APM grouping pipeline |
| `Sentry.captureMessage(msg, level)` | `captureMessage(msg, level)` | `fatal` maps to `error` (Faro has no fatal level) |
| `Sentry.setUser(user)` / `Sentry.setUser(null)` | `setUser(user)` / `clearUser()` | |
| `Sentry.setTag(key, value)` | `setTag(key, value)` | Approximation: merged into every capture's context, not an indexed label |
| `Sentry.setContext(name, ctx)` | `setContext(name, ctx)` | Flattened as `name.key` context entries |
| `beforeSend` | `init({ beforeSend })` | Runs before the mandatory PII scrubber; return `null` to drop |
| `ignoreErrors` | `init({ ignoreErrors })` | Appended to the built-in noise filters |
| `<Sentry.ErrorBoundary fallback={…}>` | `@nais/apm/react` — **coming** (Phase 1) | Will provide a searchable reference ID instead of Sentry's `eventId` |
| `tracesSampleRate` / tracing | **coming** | `tracing` option arrives with lazy-loaded `@grafana/faro-web-tracing` |

## Configuration resolution order

Each field (`app`, `version`, `environment`, `telemetryUrl`) resolves independently, highest priority first:

1. **Explicit `init()` options** — `init({ app, version, environment, telemetryUrl })`
2. **nais meta tags** in the served HTML:
   ```html
   <meta name="nais-app" content="soknad-dagpenger">
   <meta name="nais-cluster" content="prod-gcp">
   <meta name="nais-version" content="2026.07.03-abc1234">
   <meta name="nais-telemetry-url" content="https://telemetry.nav.no/collect">
   ```
3. **Build-time environment variables** — `NAIS_APP_NAME`, `NAIS_CLUSTER_NAME`, and the version derived from the `NAIS_APP_IMAGE` tag. These require your bundler to inline `process.env.*` (webpack `DefinePlugin`, Vite `define`, Next.js `env`).
4. **Collector fallback** — with no explicit/meta collector URL, the well-known nais collectors are derived from the cluster name (`prod-*` → `https://telemetry.nav.no/collect`, `dev-*` → `https://telemetry.ekstern.dev.nav.no/collect`).
5. **Dev mode** — if no collector URL resolves at all (typically localhost), nothing is sent: all telemetry is echoed to the browser console via Faro's `ConsoleTransport`, and a warning is logged once.

## PII scrubbing

A mandatory `beforeSend` pipeline scrubs every string in every outgoing signal (exception values, stack traces, log lines, context values, and `page_url`):

- **Norwegian fødselsnummer** — 11 digits, with or without a space after the first six, sanity-checked against a DDMMYY date prefix (including D-numbers, H-numbers, and synthetic test numbers) → `[fnr]`
- **Email addresses** → `[email]`
- **Token-bearing URLs** — the values of `token`, `access_token`, `id_token`, `refresh_token`, `code`, and `state` query/fragment parameters → `[redacted]`

Ordering guarantees:

- Your own `beforeSend` (if any) runs **first** and may drop items by returning `null`.
- The scrubber always runs **last** — it also sees anything your hook added.

Opt-out requires an explicit `init({ dangerouslyDisablePiiScrubbing: true })`. If you do that, you own the GDPR consequences of everything your app sends to Loki.

> Scrubbing is regex-based and best-effort. It is a safety net, **not** a GDPR guarantee — do not put personal data in error messages in the first place.

## Console capture

`console.error` calls are captured by a replacement instrumentation (Faro's own console capture is disabled — exactly one console patch is active):

- If **any argument is an `Error`**, that error is sent with its **original stack trace** and type; the remaining arguments are preserved as `context.console_message`. This fixes the `console.error('msg', err)` idiom that Faro handles poorly (see nais/grafana-apm-app#66).
- Otherwise, arguments are serialized as depth-2, 2 KB-capped, circular-safe JSON — never `[object Object]`, never `{}` — and sent as `console.error: <message>`.

**Logger utilities: use `captureException`, not `console.error`.** Console capture is the safety net, not the API:

```ts
// logger.ts — before
export function logError(msg: string, err: unknown) {
  console.error(msg, err); // works, but indirect
}

// logger.ts — after
import { captureException } from '@nais/apm';
export function logError(msg: string, err: unknown) {
  captureException(err, { context: { source: msg } });
}
```

## Dev-mode behavior

On localhost (or anywhere no collector URL resolves), `init()`:

- warns once: `[@nais/apm] No telemetry collector URL resolved …`,
- sends **nothing** over the network,
- echoes every signal to the browser console so you can see exactly what would be sent.

Calling `captureException`/`captureMessage`/`setUser` before `init()` is a safe no-op (with a single warning).

## Escape hatch

`init({ faro: { … } })` accepts raw Faro `BrowserConfig` overrides for anything this package does not expose. `beforeSend` is the exception — it stays composed with the PII scrubber.

## Development

```sh
pnpm install
pnpm test        # vitest (jsdom)
pnpm build       # tsc → dist/
```
