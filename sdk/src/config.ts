/**
 * Config resolution for @nais/apm.
 *
 * Priority order (per field):
 *   1. Explicit `init()` options
 *   2. `<meta name="nais-app|nais-cluster|nais-version|nais-telemetry-url">` tags
 *   3. Build-time environment variables (`NAIS_APP_NAME`, `NAIS_CLUSTER_NAME`,
 *      version derived from `NAIS_APP_IMAGE`) — these only work when the bundler
 *      inlines `process.env.*` (webpack DefinePlugin, Vite `define`, Next.js `env`).
 *   4. Dev fallback: no collector URL resolved → console-echo mode (warn once).
 */

export interface ConfigOptions {
  /** Application name; maps to Faro `app.name`. */
  app?: string;
  /** Application version / release; maps to Faro `app.version`. */
  version?: string;
  /** Environment (nais cluster, e.g. `prod-gcp`); maps to Faro `app.environment`. */
  environment?: string;
  /** Faro collector URL (Alloy `faro.receiver`). */
  telemetryUrl?: string;
}

export interface ResolvedConfig {
  app: string;
  version?: string;
  environment?: string;
  telemetryUrl?: string;
  /** True when no collector URL could be resolved → console-echo mode. */
  devMode: boolean;
}

// Ambient declaration so we can reference `process.env.*` literally (required for
// bundler inlining) without depending on @types/node.
declare const process: { env: Record<string, string | undefined> };

/**
 * Read an environment value defensively. The callback must contain the literal
 * `process.env.NAME` expression so bundlers can substitute it; in browsers
 * without such substitution the ReferenceError is swallowed.
 */
function safeEnv(get: () => string | undefined): string | undefined {
  try {
    const value = get();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

function readMeta(name: string): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }
  const content = document.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
  return content == null || content === '' ? undefined : content;
}

/**
 * Derive a version from a container image reference, e.g.
 * `europe-north1-docker.pkg.dev/nais/app:2026.07.03-abc1234` → `2026.07.03-abc1234`.
 */
export function versionFromImage(image: string | undefined): string | undefined {
  if (!image) {
    return undefined;
  }
  const colon = image.lastIndexOf(':');
  if (colon === -1 || colon < image.lastIndexOf('/')) {
    return undefined; // no tag, or the colon belongs to a registry port
  }
  const tag = image.slice(colon + 1);
  return tag === '' ? undefined : tag;
}

/**
 * Well-known nais collectors, derived from the cluster name as a last resort
 * (https://docs.nais.io/observability/frontend/).
 */
function telemetryUrlFromCluster(cluster: string | undefined): string | undefined {
  if (!cluster) {
    return undefined;
  }
  if (cluster.startsWith('prod-')) {
    return 'https://telemetry.nav.no/collect';
  }
  if (cluster.startsWith('dev-')) {
    return 'https://telemetry.ekstern.dev.nav.no/collect';
  }
  return undefined;
}

let warnedDevMode = false;

/** @internal test helper */
export function _resetDevModeWarning(): void {
  warnedDevMode = false;
}

export function resolveConfig(options: ConfigOptions = {}): ResolvedConfig {
  const envApp = safeEnv(() => process.env.NAIS_APP_NAME);
  const envCluster = safeEnv(() => process.env.NAIS_CLUSTER_NAME);
  // The commit SHA is the release identity that deploy annotations carry
  // (nais/grafana-apm-app#64: the deploy-annotation action defaults to
  // github.sha), so preferring GITHUB_SHA makes app.version join deploy
  // markers and release tracking without per-team convention work. The
  // image-tag derivation stays as the fallback.
  const envSha = safeEnv(() => process.env.GITHUB_SHA);
  const envVersion = envSha ?? versionFromImage(safeEnv(() => process.env.NAIS_APP_IMAGE));

  const app = options.app ?? readMeta('nais-app') ?? envApp;
  const environment = options.environment ?? readMeta('nais-cluster') ?? envCluster;
  const version = options.version ?? readMeta('nais-version') ?? envVersion;
  const telemetryUrl =
    options.telemetryUrl ?? readMeta('nais-telemetry-url') ?? telemetryUrlFromCluster(environment);

  const devMode = telemetryUrl == null;
  if (devMode && !warnedDevMode) {
    warnedDevMode = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[@nais/apm] No telemetry collector URL resolved (no init option, nais meta tag, or NAIS_* env). ' +
        'Running in dev mode: telemetry is echoed to the console and nothing is sent.'
    );
  }

  return {
    app: app ?? 'unknown-app',
    version,
    environment,
    telemetryUrl,
    devMode,
  };
}
