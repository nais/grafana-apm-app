/**
 * Typed builders for links into the public Nais documentation and the
 * @nais/apm SDK. Centralised here so every contextual "learn more" link in the
 * plugin points at the same base and the same canonical page slugs.
 *
 * URL scheme: the Nais docs are published per-tenant from the `nais/nais-doc`
 * SvelteKit site, but the canonical public base — the one the docs themselves
 * link to (e.g. https://doc.nais.io/observability/metrics/) — is tenant
 * independent. Pages are served at their path with a trailing slash, so
 * `how-to/triage-an-issue.md` resolves to
 * `https://doc.nais.io/observability/apm/how-to/triage-an-issue/`.
 *
 * The base is overridable (second arg to `docsUrl`) for the rare case a tenant
 * fork needs a different host, but every caller uses the shared default.
 */

/** Canonical public base for the Nais documentation site. */
export const DOCS_BASE_URL = 'https://doc.nais.io';

/** Home of the @nais/apm frontend SDK (the "install the SDK" destination). */
export const APM_SDK_REPO_URL = 'https://github.com/nais/apm';

/**
 * Build a docs URL from a site-relative path. Leading/trailing slashes on the
 * path are normalised away and a single trailing slash is appended to match the
 * site's canonical URLs (`/observability/apm/how-to/triage-an-issue/`).
 */
export function docsUrl(path: string, base: string = DOCS_BASE_URL): string {
  const cleanBase = base.replace(/\/+$/, '');
  const cleanPath = path.replace(/^\/+/, '').replace(/\/+$/, '');
  return cleanPath ? `${cleanBase}/${cleanPath}/` : `${cleanBase}/`;
}

/** APM docs section root, so callers compose from one place. */
const APM = 'observability/apm';

/**
 * Typed builders for every APM doc page linked from the plugin. Keyed by the
 * Diataxis slug so a call site reads as the page it opens.
 */
export const apmDocs = {
  // Tutorials
  getStarted: () => docsUrl(`${APM}/tutorials/get-started`),
  trackFrontendErrors: () => docsUrl(`${APM}/tutorials/track-frontend-errors`),
  // How-to
  triageAnIssue: () => docsUrl(`${APM}/how-to/triage-an-issue`),
  createAlerts: () => docsUrl(`${APM}/how-to/create-alerts`),
  enableSessionReplay: () => docsUrl(`${APM}/how-to/enable-session-replay`),
  collectUserFeedback: () => docsUrl(`${APM}/how-to/collect-user-feedback`),
  databaseQueries: () => docsUrl(`${APM}/how-to/database-queries`),
  logPatterns: () => docsUrl(`${APM}/how-to/log-patterns`),
  // Reference
  apmClientApi: () => docsUrl(`${APM}/reference/apm-client-api`),
  issuesModel: () => docsUrl(`${APM}/reference/issues-model`),
  urlContract: () => docsUrl(`${APM}/reference/url-contract`),
  // Explanations
  howNaisApmWorks: () => docsUrl(`${APM}/explanations/how-nais-apm-works`),
} as const;

/**
 * Frontend-observability docs section root. This is a DIFFERENT section from
 * `observability/apm` — the source-maps guideline is owned by the frontend
 * observability docs, not the APM docs — so it composes its own base.
 */
const FRONTEND = 'observability/frontend';

/**
 * Docs that live outside the APM section but are linked from APM plugin UI.
 * Keep these separate from `apmDocs` so the differing section root stays
 * explicit at the call site.
 */
export const frontendDocs = {
  // How-to: fixing minified frontend stacks (source-map resolution at ingest).
  sourcemaps: () => docsUrl(`${FRONTEND}/how-to/sourcemaps`),
} as const;
