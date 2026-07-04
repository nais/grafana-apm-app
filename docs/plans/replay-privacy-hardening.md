# Replay & crash-snapshot privacy hardening

Privacy-engineering analysis and design for the `@nais/apm` session-replay
(nais/grafana-apm-app#58) and crash-snapshot / `screenshotOnError`
(nais/grafana-apm-app#67) features.

**Purpose.** This document informs the personvernombud (data-protection
officer) conversation. It is written to be honest about residual risk, not
reassuring. The core constraint: replay and snapshot chunks land in a **shared
Loki instance used by every NAV team**, so any PII that survives capture is
readable by operators of other teams, retained for the stream's retention
window, and outside the app team's control. rrweb masking is a best-effort,
capture-time control — a determined leak through the unmask allowlist or through
un-scrubbed attributes is possible today. The sections below quantify that.

**Scope of the code read (SDK `github.com/nais/apm`, at `apm-client/`):**
`src/replay/masking.ts`, `recording.ts`, `snapshot.ts`, `transport.ts`,
`constants.ts`, `src/scrub.ts`, `src/index.ts` (init wiring); plugin playback in
`src/pages/tabs/frontend/replay/*`; Alloy relabeling in
`helm-charts/features/alloy-faro/templates/config.yaml` and its
`replay.enabled` Feature flag.

**Load-bearing technical fact established during the read.** The pinned fork
`@grafana/rrweb@2.0.0-grafana.2` / `@grafana/rrweb-snapshot@2.0.0-grafana.2`
**does not expose `maskAttributeFn`, `unmaskTextSelector`, `unblockSelector`, or
`maskInputSelector`.** Verified against
`node_modules/@grafana/rrweb/dist/rrweb.d.ts` (`recordOptions<T>`, lines 220-252)
and `@grafana/rrweb-snapshot/dist/index.d.ts` (`snapshot()` options, lines
220-241): neither type has an attribute-masking hook. This directly shapes Part 2
— attribute scrubbing cannot be done through a native rrweb callback in the
current fork; it must be done by a payload-level pass or a fork bump. The
`record()` path *does* offer `recordDOM?: boolean` (line 241), which is the
native lever for the Part 3 event-only tier.

---

## Part 1 — PII leak surface of the current masked capture

### What the floor actually does (from `masking.ts`)

The non-overridable floor spread last into `record()` / `snapshot()`:

- `maskAllInputs: true` — every `<input>`/`<textarea>`/`<select>` value masked; cannot be unmasked (correct, strong).
- `maskTextSelector: '*'` + `maskTextFn: maskText` — every **text node** masked unless it (or an ancestor) carries `data-apm-unmask`.
- `maskText` → `maskCharacters` replaces every non-whitespace char with `*` (`/\S/g`). **Length- and word-shape-preserving.**
- `blockSelector`: `img, picture, svg image, video, audio, canvas, iframe, embed, object, [data-apm-block]` (+ tighten-only extras).
- `inlineStylesheet: false`, `inlineImages: false`, `recordCanvas: false`, `collectFonts: false`, `slimDOM(Options): true/'all'`.

rrweb masks **text nodes** and **input values**. Everything else in the
serialized node tree — element attributes, the meta `href`, CSS text, `<title>`
— passes through `transformAttribute()` (which only rewrites/absolutises a
handful of attributes; it does **not** scrub). There is **no scrub pass in
`transport.ts`**: `encodeEvents()` does `JSON.stringify → gzipSync → base64`
with no interception. And although replay chunks are pushed via
`faro.api.pushEvent` and therefore *do* pass through the `scrub.ts`
`beforeSend` scrubber, the payload is already gzip+base64 by then, so the
fnr/email/token regexes match nothing. **The PII scrubber is structurally
blind to replay content.**

### Leak-surface table

| # | Vector | Masked by floor? | Likelihood of real PII | Concrete example |
|---|--------|------------------|------------------------|------------------|
| 1 | **Element attribute values** — `title`, `alt`, `aria-label`, `placeholder`, `value` on non-input custom elements, `data-*` | **No.** Fork has no `maskAttributeFn`; `transformAttribute` doesn't scrub these. | **High** | `<button title="Slett bruker Ola Nordmann (12345678901)">`; `aria-label="Melding fra fnr 12345678901"`; `<div data-user-fnr="12345678901">`; `placeholder="Ditt fødselsnummer"` reveals field purpose, and pre-filled `value=` on a non-`<input>` widget is captured verbatim. |
| 2 | **URLs in `href` / `src` / `action` / `formaction`** (path segments + query strings) | **No.** Blocked media aside, `<a href>`, `<link href>`, `<script src>`, `<form action>` serialize with query strings intact. | **High** | `<a href="/sak/12345678901/vedtak?token=eyJ...">`; `href="/api/person?fnr=12345678901&email=ola@nav.no">`. Path segments routinely carry saksnummer / aktør-id / fnr in NAV apps. |
| 3 | **Meta-event `href`** (`snapshot.ts` line 101; every rrweb Meta event) | **No.** `snapshot.ts` sets `href: window.location.href` **verbatim, unscrubbed.** | **High** | Deep-link with `?token=…` or `/behandling/{fnr}` in the address bar at crash time is shipped as-is in the first frame. |
| 4 | **Text length / word structure leakage** (`maskCharacters`) | Partially — content hidden, **shape preserved.** | **Med** (metadata, not content) | An 11-char run of `*` with no spaces reads as a fødselsnummer; `****@****.***`-shaped run reads as an email; masked sentences keep word count and line breaks, leaking document structure and field labels' lengths. |
| 5 | **DOM structure / class names / ids / test-ids** | Not masked (structure is the point of replay) | **Med** | `class="pasient-journal"`, `id="fnr-input"`, `data-testid="diagnosekode-ICD10"` leak context and sometimes the datum's *category* even when the value is masked. |
| 6 | **CSS text & `background-image` URLs** | `inlineStylesheet:false` avoids inlining sheet bodies, but **inline `style="background-image:url(/avatar/12345678901.png)"` on an element attribute is captured.** | **Low-Med** | Inline style with a PII-bearing asset URL; CSS `content:"…"` pseudo-text in an inline style. |
| 7 | **SVG `<text>`, `<title>`, `<desc>`** | `<text>` nodes are text → masked. `<title>`/`<desc>` inside SVG and element `title` attributes are **attributes/atypical text** → treated as #1. | **Low-Med** | Chart labels rendered as SVG `<title>` tooltips containing names/amounts. |
| 8 | **`<meta>` tags, JSON in `<script>` / `data-*`** | `slimDOM` drops *some* head meta; **`<script type="application/json">` bootstrap state and JSON in `data-*` are captured** (script text is a text node → masked as chars, but JSON in a `data-*` attribute is #1 and unmasked). | **High** (data-*) / **Med** (script) | `<div data-initial-state='{"fnr":"12345678901","navn":"Ola"}'>` — a very common SSR-hydration pattern — is captured verbatim. |
| 9 | **The `data-apm-unmask` allowlist** | By design disables text masking for the subtree. | **High if misused** | `closest(UNMASK_SELECTOR)` matches any **ancestor**, so `data-apm-unmask` on `<main>` or a layout wrapper **unmasks every text node in the app**. One careless attribute on a container is a full content leak. Inputs stay masked (floor), but all rendered text is exposed. |
| 10 | **`value` attribute reflected into DOM by frameworks** | `maskAllInputs` masks the *live input value property*; a framework that reflects state into a **`value="…"` attribute on a non-input** (or into `defaultValue`, `data-value`) is #1. | **Med** | React controlled components normally don't reflect to the attribute, but web components and some libs do. |

### Honest summary for the personvernombud

- The floor is **strong on the two things rrweb natively masks** (all text nodes, all input values) and those cannot be relaxed by config — only by `data-apm-unmask` markup.
- The floor is **weak-to-absent on attributes and URLs**, which in NAV apps are a *primary* PII carrier (fnr/aktør-id in paths, `data-*` hydration state, `title`/`aria-label`). The current fork gives us **no native hook** to close this.
- Masking is **length-preserving**, so even "masked" content leaks metadata (this is a known rrweb weakness).
- A single misplaced `data-apm-unmask` on a high-level container defeats text masking for its whole subtree. There is no guardrail against that today.
- **Net:** the current masked capture is *not* safe to enable on citizen-facing apps against shared Loki without either the hardening in Part 2 **and** a personvernombud sign-off, or a switch to a screenshot-less tier (Part 3).

---

## Part 2 — Hardening the masked DOM capture

Each item: the file, the specific change, and the residual risk after.

### 2.1 Attribute scrubbing — **no native hook; two viable paths**

Because the fork lacks `maskAttributeFn`, attributes cannot be masked through
rrweb config. Options, in order of preference:

- **Path A (recommended, defense-in-depth, see 2.3): scrub the serialized JSON.**
  Attribute values live as plain strings in the rrweb node tree
  (`node.attributes[name]`). A payload-level scrub that walks the serialized
  events (before gzip) catches PII-shaped attribute values with the existing
  `scrub.ts` patterns, *and* everything else structurally. This is the only
  option that needs no fork change.
- **Path B (targeted, needs fork bump): bump to an upstream rrweb that exposes
  `maskAttributeFn`** (upstream `rrweb@2.0.0-alpha.17+` has it), then set a
  function that blanks `title`/`alt`/`aria-label`/`placeholder`/`value` and drops
  all `data-*`. Cost: the player fork (`@grafana/rrweb-player@2.0.0-grafana.2`)
  must stay version-paired (see `ReplayPlayer.tsx` header) — a bump is a
  coordinated SDK+plugin change and a replay-fidelity risk. Not worth it for M-now.
- **Interim mitigation with today's fork:** add a documented convention that
  PII-bearing attributes be dropped by the app, and *aggressively* block subtrees
  known to render sensitive attributes via the tighten-only `block` list.

**`maskInputOptions` review:** currently only `maskAllInputs: true` is set, which
is sufficient (masks every input value regardless of type). Adding
`maskInputOptions` is unnecessary and could only *narrow* coverage — leave it
unset. **Do add `maskInputFn`** returning a fixed-length token (see 2.4) so input
masking stops being length-preserving too.

**Residual risk after Path A:** attribute PII that is *not* fnr/email/token-shaped
(free-text names, addresses, diagnoses) still passes — regex scrubbing does not
understand semantics. Class/id/test-id context (#5) is unchanged by design.

### 2.2 URL sanitization — `masking.ts` + `snapshot.ts` + payload pass

- **`snapshot.ts` line ~101:** replace `href: window.location.href` with
  `href: scrubUrl(window.location.href)` — a new helper that **strips the query
  string entirely** and masks PII-shaped path segments (11-digit fnr, UUID,
  email, NAV ident `^[A-Za-z]\d{6}$`). This is the single highest-value one-line
  fix: the Meta `href` is unconditionally shipped and unconditionally unscrubbed
  today.
- **DOM `href`/`src`/`action`:** the same `scrubUrl` must be applied to attribute
  values during the payload pass (2.3), since the fork won't let us intercept
  per-attribute at serialization.
- Add `scrubUrl` to `scrub.ts` (reuse `FNR_CANDIDATE`, `EMAIL`, `RAW_IDENT`; add a
  UUID pattern; drop everything after `?`/`#`).

**Residual risk:** a PII value that is *not* pattern-shaped in a path segment
(e.g. a name slug `/sak/ola-nordmann/`) survives. Stripping the whole query
string is safe but loses benign debugging context (acceptable trade).

### 2.3 Payload-level scrub pass before gzip — `transport.ts` (highest leverage)

This is the defense-in-depth backstop that compensates for the fork's missing
attribute hook. rrweb events are structured JSON; scrub the **string leaves**
before compression.

- **`transport.ts`, in `encodeEvents()`** (line ~63), before
  `gzipSync(TextEncoder…)`: run the events through a `scrubReplayEvents()` pass
  that deep-walks the event objects and applies `scrubString` + `scrubUrl` to
  every string value (reusing `scrub.ts`'s `scrubValue` walker, MAX_DEPTH raised
  for deep node trees). Because it runs on the **decompressed** JSON, the
  fnr/email/token patterns actually match — unlike the current `beforeSend`
  scrubber which sees only opaque gzip+b64.
- Feasibility: **high.** Events are plain JSON (`type`/`data`/`timestamp`); the
  scrub is O(payload) and runs in the lazy replay chunk only. Cost is a second
  pass over the serialized data — for on-error ring buffers (~60-120s) and
  snapshots (a few MB) this is low tens of ms, same order as the gzip already
  done.
- **Caveat to state plainly:** scrubbing *masked* text (`***…`) is a no-op (good);
  scrubbing attribute strings and URLs is where it earns its keep. It does **not**
  catch non-pattern PII (names, addresses) — see 2.1 residual.

**Residual risk:** semantic PII (names, free text) still passes; regex is
best-effort by the same disclaimer already in `scrub.ts` ("regex scrubbing is not
a GDPR guarantee"). But every *known-shaped* Norwegian identifier is now caught
at three layers (rrweb text mask, scrubUrl, payload scrub).

### 2.4 Non-length-preserving mask + file-input block + configurable PII-class block

- **`masking.ts` `maskCharacters`:** stop leaking length. Replace the
  per-character map with a **fixed-shape token** (e.g. always return a constant
  like `'••••'` or a bucketed length `'*** '`), and set `maskInputFn` to the same.
  Trade-off: replay layout shifts slightly since masked runs no longer match
  original width — acceptable for a privacy tier; note it for the player.
- **Block file inputs:** add `input[type=file]` to `BASE_BLOCK_SELECTORS` (a
  selected filename is PII-bearing and is *not* an input *value* rrweb masks).
- **Configurable extra-PII-class blocking:** already supported via the
  tighten-only `block` list (`buildBlockSelector`). Document a recommended default
  set (`[data-testid*=fnr]`, `.fnr`, `[data-pii]`, `input[type=file]`) and
  encourage apps to mark PII containers with `data-apm-block`.
- **Guardrail on `data-apm-unmask` (#9):** consider restricting unmask to
  *leaf/near-leaf* elements, or emit a dev-console warning when `data-apm-unmask`
  is found on an element with a large subtree. At minimum, document the blast
  radius loudly in the option JSDoc.

**Residual risk:** file-input *interaction* (that a file was chosen) still
visible; fixed-length mask still reveals *where* text exists (bounding boxes).

### Top hardening changes, ranked

1. **Scrub the Meta `href`** in `snapshot.ts` (one line, closes the highest-certainty URL leak). Residual: non-pattern path PII.
2. **Payload-level scrub pass** in `transport.ts::encodeEvents` (closes attributes + DOM URLs given no native hook). Residual: semantic PII.
3. **`scrubUrl` helper** in `scrub.ts` used by 1 and 2. Residual: name-slug paths.
4. **Fixed-length mask + block `input[type=file]`** in `masking.ts`. Residual: layout/bounding-box structure.
5. **`data-apm-unmask` blast-radius guardrail** (docs + optional dev warning). Residual: deliberate misuse remains possible — this is fundamentally best-effort.

---

## Part 3 — The "safe replay" (screenshot-less) design

The goal: a replay tier that reconstructs **no screenshot / no DOM content**, so
there is nothing for masking to leak. Two shapes.

### Option A — event / interaction-only replay

Capture interaction events **without the FullSnapshot DOM**. Two build paths:

- **A1 (native rrweb lever): `record({ recordDOM: false, … })`.** The fork's
  `recordOptions` exposes `recordDOM?: boolean` (verified, line 241). With DOM
  recording off, rrweb still emits `IncrementalSnapshot` sub-types for
  `MouseInteraction`, `Scroll`, `ViewportResize`, `Input` (already input-masked),
  and `Meta` navigation — but no node tree. **Caveat to verify before committing:
  the exact emission behaviour of `recordDOM:false` in this alpha fork needs a
  spike** (upstream added it precisely for event-only capture, but 2.x is alpha).
- **A2 (no rrweb at all): build on Faro's existing event/breadcrumb stream.**
  Faro web instrumentation already captures navigation, user interaction, and
  errors as `kind=event`. A "session timeline" can be reconstructed **purely from
  data already flowing** — add only rage-click detection (N clicks in a small
  radius/time window → one derived event) and coarse scroll/viewport events. Zero
  new DOM capture, zero rrweb in the safe tier's bundle.

**What you can show the user:** a **step timeline** — "navigated to /page →
clicked (button, masked label) → scrolled → rage-click at (x,y) → error" — with
timestamps, coordinates, element *tag/role* (never text), and the coarse
viewport. **What you cannot show:** the visual page, any text, any real layout.
It answers "what did the user *do* before the crash", not "what did they *see*".

**PII exposure:** minimal. Coordinates, tags, roles, timestamps. The only residual
is the `Meta`/navigation `href` (→ apply `scrubUrl` from Part 2) and any element
identifier carried in an interaction target (tag/id/class — apply the same
attribute discipline, but no free text or values).

### Option B — wireframe replay

rrweb **with** DOM but **total content strip**: layout + interactions, zero
content.

- All text → a **fixed generic block** (not length-preserving; e.g. every text
  node becomes a constant placeholder), via `maskTextFn`/`maskInputFn` returning a
  constant.
- **All attributes stripped** to a structural minimum (keep tag, `class` only if
  needed for layout, drop `title`/`alt`/`aria-label`/`placeholder`/`value`/`data-*`
  and scrub URLs) — via the payload pass from 2.3 running in "wireframe" mode.
- Images already blocked → render as placeholders (existing behaviour).

**What you can show:** the visual skeleton — boxes, positions, where the user
clicked, how the layout reflowed. **What you cannot show:** any real content.
It's a greyscale wireframe movie.

**PII exposure:** low but **non-zero** — layout itself can be identifying (a form
with a visible "fødselsnummer" *label position* pattern), and the wireframe still
relies on the same best-effort strip as the DOM tier. It is *safer* than DOM but
**not** in the same low-risk class as Option A.

### Recommended safe default and gating

- **Default safe tier: Option A (events).** It is the only tier with a *structural*
  privacy guarantee (no content captured, so nothing to leak beyond URLs, which we
  scrub). It flows as ordinary `kind=event` — **no Alloy replay stream needed** —
  so it can be broadly enable-able without the `replay.enabled` Helm flag and
  without per-app personvernombud sign-off (subject to a one-time DPO review of the
  *design*, not per-app).
- **Middle tier: Option B (wireframe).** Still best-effort; gate it the same way as
  DOM (behind `replay.enabled` + consent) until a DPO is comfortable it's
  content-free. Do **not** ship it as broadly-enable-able on day one.
- **Full masked-DOM tier:** stays behind the existing
  `helm-charts/features/alloy-faro` `replay.enabled` flag **plus** personvernombud
  consent, exactly as today's Feature.yaml describes.

Gating mechanics tie to the existing flag: the Alloy `stage.match` that relabels
`faro.session_recording.*` onto `kind="replay"` (config.yaml lines 108-126) is
already off by default. Events-tier data is *not* a session-recording chunk — it
rides the normal event stream — so it is unaffected by `replay.enabled` and needs
no new Alloy stage.

### API shape

Extend the existing `sessionReplay` option (`index.ts` lines 76-84) with a
`mode` that selects the tier:

```ts
sessionReplay?: {
  enabled?: boolean;
  /**
   * 'events'    — safe default: interaction timeline, NO DOM/screenshot.
   *               Flows as kind=event; broadly enable-able.
   * 'wireframe' — layout + interactions, content stripped. Consent-gated.
   * 'dom'       — current masked-DOM capture. replay.enabled + consent-gated.
   */
  mode?: 'events' | 'wireframe' | 'dom';
  captureMode?: 'on-error' | 'always';   // renamed from today's `mode`
  sampleRate?: number;
  block?: string[];
};
```

- **Default when `enabled: true` and `mode` omitted → `'events'`** (safe by
  default; opting *up* to `wireframe`/`dom` is an explicit, DPO-visible choice).
- Note the rename: today `sessionReplay.mode` means `'on-error' | 'always'`; that
  moves to `captureMode` so `mode` can name the privacy tier. This is a
  pre-GA/PREVIEW option (JSDoc already says NOT GA), so the break is acceptable —
  flag it in CHANGELOG.

**SDK changes per tier:**

- `events`: new `src/replay/events.ts` (A1 `recordDOM:false` wrapper *or* A2 Faro-stream derivation) + rage-click detector; reuses `transport.ts` with a new `mode="events"` (extend `ReplayMode` in `constants.ts`) or rides `kind=event` directly.
- `wireframe`: reuse `recording.ts`/`snapshot.ts` with a "wireframe" masking profile in `masking.ts` (constant-text `maskTextFn`, attribute strip via 2.3 pass).
- `dom`: unchanged from today.

**Plugin changes per tier:**

- `events`: a **timeline renderer** (no rrweb-player) in `src/pages/tabs/frontend/replay/` — a new lightweight component; `fetchReplay.ts` gains an events-tier query path (or reuses the event stream). This is *new* UI, not the rrweb player.
- `wireframe`: the existing `ReplayPlayer.tsx` renders it unchanged (it's still rrweb events) — add a "Wireframe" badge alongside the existing "Masked snapshot"/"Session replay" badges.
- `dom`: unchanged.
- `probeReplay`/`fetchReplay` `event_data_mode` gains `events`/`wireframe` values (currently `snapshot`/`recording`); the drawer picks the renderer by mode.

---

## Part 4 — Recommendation and rollout

### Tiered rollout

1. **Build first: the safe events tier (Option A) as the default.** It is the only
   tier that changes the risk *class* rather than shrinking the risk *surface*. It
   needs no Alloy flag and no per-app consent, so it unblocks broad adoption of
   "what did the user do before the crash" while the DOM tier stays gated. Prefer
   **A2 (Faro-stream derivation)** for the first cut — it adds no rrweb to the safe
   path and reuses data already scrubbed by `beforeSend`; treat **A1
   (`recordDOM:false`)** as a spike to validate before relying on it.
2. **Then: the Part 2 hardening for the DOM tier** — in priority order 2.2 (Meta
   `href` scrub) → 2.3 (payload scrub pass) → 2.4 (fixed-length mask, file-input
   block). These make the consent-gated DOM tier defensible; they do not remove the
   need for consent.
3. **Then: wireframe (Option B)** as a middle tier, gated like DOM until a DPO
   accepts it as content-free.
4. **Fork-`maskAttributeFn` bump (Path B in 2.1): defer.** Only pursue if the
   payload-pass residual proves insufficient and a coordinated
   recorder+player fork bump is scheduled.

### What the personvernombud signs off, per tier

- **events (default):** a *design* review, once — confirm the timeline captures
  no content, only interaction metadata + scrubbed URLs. No per-app sign-off. This
  is the tier to lead the conversation with.
- **wireframe:** per-tier sign-off that "content-stripped layout + click positions"
  is acceptable in shared Loki; acknowledge residual layout-identifiability and
  best-effort strip.
- **dom:** per-app sign-off (citizen-facing especially), acknowledging the Part 1
  leak surface — attributes/URLs are best-effort, `data-apm-unmask` misuse is
  possible, masking is length-preserving-until-2.4. This is the real-risk picture
  they must accept.

### Crash-snapshot (`screenshotOnError`) — gap to close

`screenshotOnError` (`snapshot.ts`, wired in `index.ts` lines 165-195) is a
**DOM-tier** capture — a full masked DOM node tree — and therefore inherits the
DOM tier's consent requirement. **But today it does not honour any gate:**

- `wantSnapshot = options.screenshotOnError === true && !wantRecording` (index.ts
  line 165) turns it on from an SDK option alone.
- It ships via `faro.api.pushEvent(faro.session_recording.chunk, …)` →
  `sendEvents(…, 'snapshot', …)` → lands in shared Loki as **`kind=event`**.
- The Helm `replay.enabled` flag (`alloy-faro/config.yaml` lines 108-126) only
  controls **relabeling** `faro.session_recording.*` onto `kind="replay"`. It does
  **not** control whether the data *lands* — `kind=event` chunks arrive
  regardless. The plugin reader even queries `kind=~"event|replay"` (`fetchReplay.ts`
  line 75), so it reads them either way.

**Net: a team can set `screenshotOnError: true` and push masked full-DOM
snapshots into shared Loki with no `replay.enabled`, no Alloy gate, and no
personvernombud step.** That is a real gap and should be flagged in the DPO
conversation.

**Recommended fix:** make the DOM tier (recording *and* snapshot) genuinely
gated — options, best combined:

- **Server/Alloy-side enforcement:** drop `faro.session_recording.chunk`
  `mode="snapshot"|"recording"` events unless `replay.enabled` is set (a
  `stage.drop`/match in the Alloy config), so the *ingest* gate is not
  client-trusted.
- **SDK-side consent flag:** require an explicit `sessionReplay.mode: 'dom'` (or a
  dedicated `consentAcknowledged`) before `screenshotOnError` produces DOM-tier
  chunks; otherwise degrade `screenshotOnError` to attach only an **events-tier**
  breadcrumb.
- **Minimum, immediately:** treat `screenshotOnError` as DOM-tier in the docs and
  the DPO sign-off, and align its gating with `replay.enabled` so the two DOM-tier
  features share one consent story.

### Honest bottom line

rrweb masking is fundamentally **best-effort**: it reliably masks text nodes and
input values, but in this fork it gives us **no hook for attributes**, it leaks
length, and a single `data-apm-unmask` can unmask a subtree. Against a shared,
multi-team Loki, "masked DOM" is a *risk-reduction*, not a *guarantee* — the
personvernombud should treat the DOM and wireframe tiers as consent-gated
best-effort, and the events tier as the broadly-safe default. The hardening in
Part 2 is worth doing regardless, but it does not turn the DOM tier into
something that is safe without sign-off.
