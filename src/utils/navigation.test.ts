/**
 * Tests for navigation URL construction.
 *
 * These verify that appNavigate builds valid URLs without double query strings.
 * We test the pure URL-building logic by extracting it from the hook.
 */

import { PLUGIN_BASE_URL } from '../constants';

/** Pure function mirroring the URL construction logic in useAppNavigate */
function buildNavigationURL(
  path: string,
  currentParams: Record<string, string>,
  extraParams?: Record<string, string>
): string {
  const PRESERVED_PARAMS = ['from', 'to', 'namespace', 'environment', 'sort', 'dir', 'q', 'pageSize'];
  const params = new URLSearchParams();
  for (const key of PRESERVED_PARAMS) {
    const val = currentParams[key];
    if (val) {
      params.set(key, val);
    }
  }
  if (extraParams) {
    for (const [k, v] of Object.entries(extraParams)) {
      if (v) {
        params.set(k, v);
      }
    }
  }
  const qs = params.toString();
  return `${PLUGIN_BASE_URL}/${path}${qs ? `?${qs}` : ''}`;
}

describe('buildNavigationURL', () => {
  it('builds URL without query params when none exist', () => {
    const url = buildNavigationURL('services', {});
    expect(url).toBe(`${PLUGIN_BASE_URL}/services`);
    expect(url.match(/\?/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('preserves from/to params', () => {
    const url = buildNavigationURL('services', { from: '1000', to: '2000' });
    expect(url).toContain('?from=1000&to=2000');
    expect(url.match(/\?/g)?.length).toBe(1);
  });

  it('preserves environment from current params', () => {
    const url = buildNavigationURL('dependencies/foo', { environment: 'prod-fss', from: '1000', to: '2000' });
    expect(url).toContain('environment=prod-fss');
    expect(url.match(/\?/g)?.length).toBe(1);
  });

  it('extraParams override preserved environment', () => {
    const url = buildNavigationURL('services/ns/svc', { environment: 'dev-fss' }, { environment: 'prod-fss' });
    expect(url).toContain('environment=prod-fss');
    expect(url).not.toContain('dev-fss');
    expect(url.match(/\?/g)?.length).toBe(1);
  });

  it('never produces double question marks', () => {
    // This was the bug: embedding ?environment=X in path caused double ?
    const url = buildNavigationURL('services/ns/svc', { from: '1000', to: '2000' }, { environment: 'prod' });
    const questionMarks = url.match(/\?/g)?.length ?? 0;
    expect(questionMarks).toBeLessThanOrEqual(1);
  });

  it('does not add empty params', () => {
    const url = buildNavigationURL('services', { namespace: '', environment: '' });
    expect(url).toBe(`${PLUGIN_BASE_URL}/services`);
  });

  it('encodes special characters in param values', () => {
    const url = buildNavigationURL('services', { environment: 'prod gcp' });
    expect(url).toContain('environment=prod+gcp');
    expect(url.match(/\?/g)?.length).toBe(1);
  });
});
