# Frontend source maps on Nais

> **TARGET LOCATION:** nais docs (docs.nais.io), alongside the existing
> [frontend observability page](https://docs.nais.io/observability/frontend/).
> Link to it from the Nais APM plugin's Frontend tab once the plugin ships
> the Phase 2 "source map doctor" hint (nais/grafana-apm-app#60).
>
> Source: nais/grafana-apm-app#60, Phase 0. Milestone M0 (target v0.14),
> Platform track. Pairs with the live Alloy `faro.receiver` config — now
> applied to `helm-charts/features/alloy-faro/templates/config.yaml` in
> nais/helm-charts (the Alloy-side half of this guideline) — and with
> `infra/docs/meta-tag-contract.md` (how `app.release` gets resolved).

## Why this exists

Alloy's `faro.receiver` resolves stack traces to source at **ingest time**,
by downloading your app's minified JS from the URL in each stack frame and
following its `sourceMappingURL`. If that fetch fails — because your app
sits behind Wonderwall, or your maps aren't there yet — the frame is stored
minified in Loki **permanently**. Symbolication never happens retroactively.

Follow this guideline and the ExceptionDrawer in Nais APM shows real
function names and file/line numbers instead of `at t
(/assets/index-BhX2r9.js:2:48211)`.

## The contract

### 1. Build with source maps on

- Webpack: `devtool: 'source-map'` (not `eval-source-map` or
  `hidden-source-map` — see the troubleshooting section below for why
  `hidden-source-map` silently breaks this whole pipeline).
- Vite: `build.sourcemap: true`.

Either way you need a real `//# sourceMappingURL=...` comment at the end of
each emitted JS file — Alloy regex-extracts that comment to find the map.

### 2. Publish to a versioned, immutable CDN prefix

Set your bundler's public-path / asset-prefix to:

```
https://cdn.nav.no/<team>/<app>/<release>/
```

- `<release>` **must** be unique per deploy and never reused — this is what
  makes an old bundle's frame URL keep resolving to the matching old map
  forever, even after you've shipped ten releases since. It is the same
  value `@nais/apm` sets as `app.release`/`app.version` (default: the build
  commit SHA — see `infra/docs/meta-tag-contract.md` and
  nais/grafana-apm-app#59). Faro/Alloy has no debug-ID support (unlike
  Sentry's `//# debugId=`), so this versioned-path convention is our
  equivalent: it solves the same "which map matches this exact bundle" skew
  problem without needing a stamped ID.
- Upload the **whole** `dist/` directory, including the `.map` files, to
  that prefix. Don't upload only the JS and skip the maps.
- Most NAV frontend source is public per NAV's open-source policy, so a
  public CDN path is the default, acceptable choice. If your app must not
  publish source publicly, use the non-public `location` block opt-out
  documented (as a commented block) in the live Alloy config at
  `helm-charts/features/alloy-faro/templates/config.yaml` — that is the
  exception, not the default.

### 3. CI ordering: upload maps BEFORE you deploy

```
build → upload dist/ (incl. .map) to cdn.nav.no/<team>/<app>/<release>/ → deploy
```

**This ordering is not optional — it's the difference between working and
permanently-broken symbolication for that release.** Here's the trap:

> Alloy caches a **failed** map download for `error_cleanup_interval`
> (default 1h, tuned to 5m by the platform Alloy config in
> `helm-charts/features/alloy-faro`) before
> retrying. If your app deploys and starts serving traffic — and therefore
> can start throwing exceptions — before its maps exist at the CDN path,
> the very first exception poisons Alloy's cache for that bundle URL. Every
> exception for up to an hour afterwards (even after the maps land) reads
> from the cached failure and stays minified. There is no manual "retry now"
> — you just wait out the cache window, or the release ages out of
> relevance before anyone notices the stacks are still garbage.

Upload-before-deploy makes this trap structurally impossible: by the time
the new bundle can produce a single exception, its maps are already
resolvable.

## "Why is my stack still minified?" — troubleshooting checklist

Work through these in order; this is also what the plugin's Phase 2 "source
map doctor" automates.

1. **Error cache window.** Did an exception fire in the window between
   deploy and the CDN upload finishing? If so, minified frames for that
   release will self-heal after `error_cleanup_interval` — but only for
   *new* occurrences. This is expected, not a config bug.
2. **Old logs stay minified forever.** Symbolication happens once, at
   ingest. Fixing your config (or re-uploading missing maps) only affects
   exceptions ingested *after* the fix — it does not retroactively
   re-symbolicate anything already in Loki. If you need clean history,
   there is no backfill path; this is a declared non-goal of #60.
3. **Origin allowlist.** Is the frame URL actually served from
   `cdn.nav.no`? Alloy's `download_from_origins` only matches that host
   (`wildcard.Match(origin+"*", url)`, so subpaths are fine, other hosts
   are not). A stack frame still pointing at your app's own origin (e.g.
   you forgot to set `publicPath`/`assetPrefix`) will never resolve.
4. **`hidden-source-map` breaks discovery.** Alloy's direct-download path
   works by regex-matching the `//# sourceMappingURL=` comment in the
   downloaded JS file. Webpack's `hidden-source-map` deliberately omits that
   comment (it still emits `.map` files, but nothing points at them) — this
   is indistinguishable, from Alloy's point of view, from "no map exists at
   all". Use `source-map`, not `hidden-source-map`.
5. **Release mismatch.** Does the `app.release`/`app.version` your SDK sent
   with the exception match the `<release>` segment in the CDN path the
   bundle was actually uploaded to? If your CI or SDK config computes the
   release value differently in two places (e.g. one uses the git SHA, the
   other a build timestamp), the frame URL and the CDN prefix diverge and
   the map 404s even though it exists somewhere.
6. **Check the Alloy metrics.** `faro_receiver_sourcemap_downloads_total{origin,http_status}`
   tells you whether Alloy is even attempting the right origin and what
   HTTP status it's getting back (404 = maps not there / wrong path; other
   4xx/5xx = something else broke). `faro_receiver_sourcemap_file_reads_total{origin,status}`
   and `faro_receiver_sourcemap_cache_size{origin}` round out the picture —
   a large, ever-growing cache size can also indicate high release churn
   without a `ttl` set (see the `cache` block note in the Alloy config).

## What this guideline deliberately does not do

- It does not reimplement Grafana Cloud's source-map upload API — that API
  is Cloud-only by design and unnecessary once URL-convention resolution
  (the versioned CDN path) is in place.
- It does not attempt query-time or browser-side symbolication. Resolution
  stays at ingest, in Alloy; the plugin only detects and explains failures.
- It does not authenticate Alloy through Wonderwall/ID-porten to fetch maps
  from app origins directly — machine-auth through a user-auth proxy is
  fragile and per-app; routing through the CDN removes the problem instead.
