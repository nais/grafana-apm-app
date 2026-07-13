# Seed: deterministic synthetic Faro telemetry (#90)

Generates realistic browser telemetry in the Grafana Faro collector wire
format — sessions with web vitals, exceptions with stack traces (Faro shape
_and_ console-captured shape), custom events/measurements, and deliberate
**PII canaries** — and POSTs it to an Alloy `faro.receiver` (or stdout).

```bash
pnpm seed                                        # dry run: NDJSON to stdout
pnpm seed --url http://localhost:12347/collect   # send to a faro.receiver
pnpm seed --seed 7 --duration 60 --sessions 8    # bigger, still deterministic
pnpm seed --base 1783252800000                   # fixed clock → byte-reproducible
```

Properties (asserted by `generator.test.ts`):

- **Deterministic** — same `(seed, base)` → byte-identical output. Content
  never reads the wall clock; only the default `--base` is "now" so fresh
  seeds land in dashboards' default time range.
- **Coverage** — 2 teams × 2 apps × 2 environments; all five web vitals per
  session; fingerprint-stable error catalog (Issues grouping is assertable).
- **PII canaries** — one per app × environment, marked with a `canary`
  context key and carrying raw fnr/email/token values. If any canary value
  is visible in a panel, pipeline scrubbing is broken; the marker makes both
  outcomes assertable end to end.

Consumed three ways (see #90): plugin e2e against the compose LGTM stack,
SDK smoke tests against a real receiver, and the auto-config acceptance
criteria in #133.
