/**
 * The generator's contract (#90): deterministic, complete coverage of the
 * scenario dimensions, and PII canaries present and findable.
 */
import { generateScenario, mulberry32 } from './generator';

const BASE = Date.UTC(2026, 6, 12, 12, 0, 0); // fixed clock — full determinism

describe('generateScenario', () => {
  it('is byte-deterministic for the same (seed, base)', () => {
    const a = generateScenario({ seed: 42, baseTimeMs: BASE });
    const b = generateScenario({ seed: 42, baseTimeMs: BASE });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('differs for different seeds', () => {
    const a = generateScenario({ seed: 42, baseTimeMs: BASE });
    const b = generateScenario({ seed: 7, baseTimeMs: BASE });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('covers 2 namespaces × 2 apps × 2 environments', () => {
    const payloads = generateScenario({ seed: 42, baseTimeMs: BASE });
    const combos = new Set(payloads.map((p) => `${p.meta.app.namespace}/${p.meta.app.name}/${p.meta.app.environment}`));
    expect(combos).toEqual(
      new Set([
        'team-checkout/shop-frontend/prod-gcp',
        'team-checkout/shop-frontend/dev-gcp',
        'team-search/search-ui/prod-gcp',
        'team-search/search-ui/dev-gcp',
      ])
    );
  });

  it('emits all five web vitals for every session', () => {
    const payloads = generateScenario({ seed: 42, baseTimeMs: BASE });
    for (const payload of payloads) {
      const vitals = payload.measurements.filter((m) => m.type === 'web-vitals').flatMap((m) => Object.keys(m.values));
      expect(new Set(vitals)).toEqual(new Set(['ttfb', 'fcp', 'lcp', 'inp', 'cls']));
    }
  });

  it('keeps exception fingerprints stable (fixed catalog, both shapes)', () => {
    const payloads = generateScenario({ seed: 42, baseTimeMs: BASE });
    const values = new Set(payloads.flatMap((p) => p.exceptions.map((e) => e.value)));
    expect(values).toEqual(
      new Set([
        "Cannot read properties of undefined (reading 'items')",
        'Failed to fetch',
        'Uncaught Error: kunne ikke hente saksliste',
      ])
    );
    // Console-captured shape present: an exception with console_message context.
    expect(payloads.some((p) => p.exceptions.some((e) => e.context?.['console_message'] != null))).toBe(true);
  });

  it('plants exactly one PII canary per app × environment, marked and findable', () => {
    const payloads = generateScenario({ seed: 42, baseTimeMs: BASE });
    const canaries = payloads.flatMap((p) => p.logs.filter((l) => l.context?.['canary']));
    expect(canaries).toHaveLength(4); // 2 apps × 2 environments
    for (const canary of canaries) {
      expect(canary.context?.['canary']).toMatch(/^pii-/);
    }
    // The identifiers are raw here by design — the pipeline must scrub them.
    const messages = canaries.map((c) => c.message).join('\n');
    expect(messages).toContain('01017012345');
  });

  it('keeps every timestamp inside the requested window', () => {
    const duration = 30;
    const payloads = generateScenario({ seed: 42, baseTimeMs: BASE, durationMinutes: duration });
    const timestamps = payloads.flatMap((p) => [
      ...p.exceptions.map((e) => e.timestamp),
      ...p.logs.map((l) => l.timestamp),
      ...p.measurements.map((m) => m.timestamp),
      ...p.events.map((e) => e.timestamp),
    ]);
    for (const ts of timestamps) {
      const ms = Date.parse(ts);
      expect(ms).toBeGreaterThanOrEqual(BASE - duration * 60_000);
      expect(ms).toBeLessThanOrEqual(BASE);
    }
  });
});

describe('mulberry32', () => {
  it('produces a stable sequence in [0, 1)', () => {
    const rng = mulberry32(1);
    const sequence = [rng(), rng(), rng()];
    const again = mulberry32(1);
    expect([again(), again(), again()]).toEqual(sequence);
    for (const v of sequence) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('input validation', () => {
  it('rejects sub-minute, non-finite, and non-positive inputs', () => {
    expect(() => generateScenario({ baseTimeMs: NaN })).toThrow(RangeError);
    expect(() => generateScenario({ baseTimeMs: BASE, durationMinutes: 0.5 })).toThrow(RangeError);
    expect(() => generateScenario({ baseTimeMs: BASE, durationMinutes: NaN })).toThrow(RangeError);
    expect(() => generateScenario({ baseTimeMs: BASE, sessionsPerApp: 0 })).toThrow(RangeError);
  });
});
