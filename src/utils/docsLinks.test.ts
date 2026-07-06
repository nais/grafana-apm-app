import { docsUrl, apmDocs, frontendDocs, DOCS_BASE_URL, APM_SDK_REPO_URL } from './docsLinks';

describe('docsUrl', () => {
  it('builds a trailing-slash URL against the default public base', () => {
    expect(docsUrl('observability/apm/how-to/triage-an-issue')).toBe(
      'https://doc.nais.io/observability/apm/how-to/triage-an-issue/'
    );
  });

  it('normalises leading and trailing slashes on the path', () => {
    expect(docsUrl('/observability/apm/')).toBe('https://doc.nais.io/observability/apm/');
    expect(docsUrl('///a/b///')).toBe('https://doc.nais.io/a/b/');
  });

  it('returns the base root for an empty path', () => {
    expect(docsUrl('')).toBe('https://doc.nais.io/');
  });

  it('honours an overridden base and strips its trailing slash', () => {
    expect(docsUrl('observability/apm', 'https://docs.example.cloud.nais.io/')).toBe(
      'https://docs.example.cloud.nais.io/observability/apm/'
    );
  });

  it('exposes the canonical public base and SDK repo', () => {
    expect(DOCS_BASE_URL).toBe('https://doc.nais.io');
    expect(APM_SDK_REPO_URL).toBe('https://github.com/nais/apm');
  });
});

describe('apmDocs builders', () => {
  it('map each Diataxis slug to its canonical published URL', () => {
    expect(apmDocs.getStarted()).toBe('https://doc.nais.io/observability/apm/tutorials/get-started/');
    expect(apmDocs.trackFrontendErrors()).toBe(
      'https://doc.nais.io/observability/apm/tutorials/track-frontend-errors/'
    );
    expect(apmDocs.triageAnIssue()).toBe('https://doc.nais.io/observability/apm/how-to/triage-an-issue/');
    expect(apmDocs.createAlerts()).toBe('https://doc.nais.io/observability/apm/how-to/create-alerts/');
    expect(apmDocs.enableSessionReplay()).toBe('https://doc.nais.io/observability/apm/how-to/enable-session-replay/');
    expect(apmDocs.collectUserFeedback()).toBe('https://doc.nais.io/observability/apm/how-to/collect-user-feedback/');
    expect(apmDocs.databaseQueries()).toBe('https://doc.nais.io/observability/apm/how-to/database-queries/');
    expect(apmDocs.logPatterns()).toBe('https://doc.nais.io/observability/apm/how-to/log-patterns/');
    expect(apmDocs.backendExceptions()).toBe(
      'https://doc.nais.io/observability/apm/how-to/backend-exceptions-as-issues/'
    );
    expect(apmDocs.apmClientApi()).toBe('https://doc.nais.io/observability/apm/reference/apm-client-api/');
    expect(apmDocs.issuesModel()).toBe('https://doc.nais.io/observability/apm/reference/issues-model/');
    expect(apmDocs.urlContract()).toBe('https://doc.nais.io/observability/apm/reference/url-contract/');
    expect(apmDocs.howNaisApmWorks()).toBe('https://doc.nais.io/observability/apm/explanations/how-nais-apm-works/');
  });
});

describe('frontendDocs builders', () => {
  it('links the source-maps guideline under the frontend (not apm) docs section', () => {
    // #60: the sourcemaps doc lives under observability/frontend, a different
    // section from the observability/apm slugs.
    expect(frontendDocs.sourcemaps()).toBe('https://doc.nais.io/observability/frontend/how-to/sourcemaps/');
  });
});
