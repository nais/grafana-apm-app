/**
 * Deterministic synthetic Faro telemetry generator (#90).
 *
 * Produces the Grafana Faro collector wire format (the JSON an app
 * instrumented with @nais/apm POSTs to an Alloy `faro.receiver`): sessions
 * with web vitals, exceptions with realistic stack traces (both the Faro
 * browser shape and the console-captured shape), custom events/measurements,
 * and deliberate PII canaries so pipeline scrubbing can be verified end to
 * end.
 *
 * Deterministic by construction: a seeded PRNG and a caller-supplied base
 * timestamp mean the same (seed, baseTimeMs) always yields byte-identical
 * output — panel assertions stay stable and failures reproduce. Only the
 * clock base is a parameter (dashboards need recent data); content never
 * depends on the wall clock.
 *
 * No runtime dependencies — plain erasable TypeScript, runnable via
 * `node --experimental-strip-types` (see cli.ts).
 */

// --- Wire format (Faro collector TransportBody, kept intentionally local:
// --- the plugin repo does not depend on @grafana/faro-web-sdk) -------------

export interface FaroMeta {
  sdk: { name: string; version: string };
  app: {
    name: string;
    namespace: string;
    version: string;
    environment: string;
    release: string;
  };
  session: { id: string; attributes?: Record<string, string> };
  browser: { name: string; version: string; os: string; mobile: boolean };
  page: { url: string };
  user?: { id: string };
}

export interface FaroException {
  type: string;
  value: string;
  timestamp: string;
  stacktrace?: { frames: FaroFrame[] };
  context?: Record<string, string>;
}

export interface FaroFrame {
  filename: string;
  function: string;
  lineno: number;
  colno: number;
}

export interface FaroLog {
  message: string;
  level: 'info' | 'warn' | 'error';
  timestamp: string;
  context?: Record<string, string>;
}

export interface FaroMeasurement {
  type: string;
  values: Record<string, number>;
  timestamp: string;
  context?: Record<string, string>;
}

export interface FaroEvent {
  name: string;
  domain?: string;
  attributes?: Record<string, string>;
  timestamp: string;
}

/** One POST body to the faro.receiver — one session's batch. */
export interface FaroPayload {
  meta: FaroMeta;
  exceptions: FaroException[];
  logs: FaroLog[];
  measurements: FaroMeasurement[];
  events: FaroEvent[];
}

// --- Deterministic primitives ----------------------------------------------

/** mulberry32 — tiny, fast, deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

const int = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, items: readonly T[]): T => items[int(rng, 0, items.length - 1)]!;
const hex = (rng: Rng, length: number): string =>
  Array.from({ length }, () => '0123456789abcdef'[int(rng, 0, 15)]).join('');

// --- Scenario model ----------------------------------------------------------

export interface SeedOptions {
  /** PRNG seed; same seed + baseTimeMs → identical output. Default 42. */
  seed?: number;
  /** Epoch ms the generated window ENDS at (i.e. "now"). */
  baseTimeMs: number;
  /** Length of the generated window, minutes. Default 30. */
  durationMinutes?: number;
  /** Sessions generated per app × environment. Default 4. */
  sessionsPerApp?: number;
}

/** Two teams × two apps × two environments — exercises attribution/filtering. */
const APPS = [
  { app: 'shop-frontend', namespace: 'team-checkout', routes: ['/', '/produkter', '/handlekurv', '/kasse'] },
  { app: 'search-ui', namespace: 'team-search', routes: ['/', '/sok', '/resultater'] },
] as const;

const ENVIRONMENTS = ['prod-gcp', 'dev-gcp'] as const;

const BROWSERS = [
  { name: 'Chrome', version: '138.0', os: 'macOS 15', mobile: false },
  { name: 'Firefox', version: '141.0', os: 'Windows 11', mobile: false },
  { name: 'Safari', version: '18.5', os: 'iOS 18', mobile: true },
  { name: 'Edge', version: '138.0', os: 'Windows 11', mobile: false },
] as const;

/**
 * Fixed error catalog — fingerprint-stable across runs so the Issues tab
 * groups them identically every time. Frames reference content-hashed bundle
 * names like real CI builds produce.
 */
const ERROR_CATALOG = [
  {
    type: 'TypeError',
    value: "Cannot read properties of undefined (reading 'items')",
    frames: [
      {
        filename: 'https://cdn.nav.no/team/app/assets/index-b3f9c2d1.js',
        function: 'renderCart',
        lineno: 2,
        colno: 41712,
      },
      { filename: 'https://cdn.nav.no/team/app/assets/index-b3f9c2d1.js', function: 'Wc', lineno: 2, colno: 18220 },
    ],
  },
  {
    type: 'Error',
    value: 'Failed to fetch',
    frames: [
      {
        filename: 'https://cdn.nav.no/team/app/assets/api-7e2a91f0.js',
        function: 'fetchWithRetry',
        lineno: 1,
        colno: 8804,
      },
    ],
  },
] as const;

/** Console-captured shape (no structured stack — see nais/grafana-apm-app#66). */
const CONSOLE_ERROR = {
  type: 'Error',
  value: 'Uncaught Error: kunne ikke hente saksliste',
} as const;

/**
 * PII canaries — deliberately UNscrubbed identifiers, marked with a
 * `canary` context key so tests can (a) find them and (b) assert what the
 * pipeline did with them. `01017012345` has a plausible date prefix;
 * the values must never appear in a panel if scrubbing works.
 */
const PII_CANARIES = [
  { canary: 'pii-fnr', value: 'kunne ikke lagre bruker 01017012345' },
  { canary: 'pii-email', value: 'validation failed for ola.nordmann@nav.no' },
  // Not a real credential — a JWT-shaped canary (header 'eyJ…' + the literal
  // word 'secret') that the pipeline's token scrubbing must redact.
  { canary: 'pii-token', value: 'redirect to /callback?token=eyJhbGciOiJIUzI1NiJ9.secret' }, // gitleaks:allow
] as const;

// --- Generator ---------------------------------------------------------------

export function generateScenario(options: SeedOptions): FaroPayload[] {
  const seed = options.seed ?? 42;
  const durationMs = (options.durationMinutes ?? 30) * 60_000;
  const sessionsPerApp = options.sessionsPerApp ?? 4;
  const startMs = options.baseTimeMs - durationMs;
  const rng = mulberry32(seed);

  const payloads: FaroPayload[] = [];

  for (const environment of ENVIRONMENTS) {
    for (const { app, namespace, routes } of APPS) {
      const version = `2026.07.10-${hex(rng, 7)}`;
      for (let s = 0; s < sessionsPerApp; s++) {
        const sessionStartMs = startMs + int(rng, 0, durationMs - 60_000);
        const at = (offsetMs: number): string => new Date(sessionStartMs + offsetMs).toISOString();
        const browser = pick(rng, BROWSERS);
        const route = pick(rng, routes);
        const pageUrl = `https://${app}.intern.nav.no${route}`;

        const payload: FaroPayload = {
          meta: {
            sdk: { name: 'nais-apm-seed', version: '1.0.0' },
            app: { name: app, namespace, version, environment, release: version },
            session: { id: hex(rng, 16), attributes: { isSampled: 'true' } },
            browser: { ...browser },
            page: { url: pageUrl },
            user: { id: hex(rng, 32) }, // opaque hash, per the SDK's setUser contract
          },
          exceptions: [],
          logs: [],
          measurements: [],
          events: [{ name: 'session_start', domain: 'browser', attributes: {}, timestamp: at(0) }],
        };

        // Web vitals — one set per session pageload.
        const vitals: Record<string, number> = {
          ttfb: int(rng, 80, 800),
          fcp: int(rng, 400, 2500),
          lcp: int(rng, 800, 4000),
          inp: int(rng, 40, 500),
          cls: int(rng, 0, 30) / 100,
        };
        for (const [name, value] of Object.entries(vitals)) {
          payload.measurements.push({
            type: 'web-vitals',
            values: { [name]: value },
            timestamp: at(int(rng, 500, 5_000)),
            context: { page_url: pageUrl },
          });
        }

        // Roughly a third of sessions hit a catalog error (fingerprint-stable);
        // the first session per app also emits the console-captured shape.
        if (s % 3 === 0) {
          const error = pick(rng, ERROR_CATALOG);
          payload.exceptions.push({
            type: error.type,
            value: error.value,
            timestamp: at(int(rng, 5_000, 30_000)),
            stacktrace: { frames: [...error.frames] },
            context: { page_url: pageUrl },
          });
        }
        if (s === 0) {
          payload.exceptions.push({
            type: CONSOLE_ERROR.type,
            value: CONSOLE_ERROR.value,
            timestamp: at(int(rng, 5_000, 30_000)),
            context: { console_message: CONSOLE_ERROR.value, page_url: pageUrl },
          });
        }

        // Custom signals (#120): one measurement + one event per session.
        payload.measurements.push({
          type: 'checkout_latency',
          values: { ms: int(rng, 120, 1_800) },
          timestamp: at(int(rng, 10_000, 50_000)),
        });
        payload.events.push({
          name: 'feature_flag_evaluated',
          attributes: { flag: 'ny-kasse', value: pick(rng, ['on', 'off']) },
          timestamp: at(int(rng, 1_000, 20_000)),
        });

        // Exactly one PII-canary session per app × environment (the last one):
        // an error log carrying identifiers that MUST NOT survive the pipeline.
        if (s === sessionsPerApp - 1) {
          const canary = PII_CANARIES[(payloads.length + s) % PII_CANARIES.length]!;
          payload.logs.push({
            message: canary.value,
            level: 'error',
            timestamp: at(int(rng, 20_000, 55_000)),
            context: { canary: canary.canary },
          });
        }

        payloads.push(payload);
      }
    }
  }

  return payloads;
}
