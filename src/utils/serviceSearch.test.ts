import { createServiceSearchIndex, searchServices, SearchableService } from './serviceSearch';

const services: SearchableService[] = [
  { name: 'nais-payment-service', namespace: 'team-payments' },
  { name: 'nais-payment-gateway', namespace: 'team-payments' },
  { name: 'auth-service', namespace: 'team-auth' },
  { name: 'oauth-gateway', namespace: 'team-auth' },
  { name: 'frontend-web', namespace: 'team-web', team: 'web-squad' },
];

function search(query: string) {
  const index = createServiceSearchIndex(services);
  return searchServices(services, query, index);
}

describe('searchServices', () => {
  it('returns the original list unchanged for an empty query', () => {
    expect(search('')).toBe(services);
    expect(search('   ')).toBe(services);
  });

  it('matches out-of-order, partial (typo) tokens', () => {
    // "paymnt svc" — misspelled "payment" + abbreviated "service"
    const results = search('paymnt svc');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('nais-payment-service');
  });

  it('matches acronym-ish partial input', () => {
    // "nps" — first letters of "nais", "payment", "service"
    const results = search('nps');
    const names = results.map((r) => r.name);
    expect(names).toContain('nais-payment-service');
  });

  it('ranks exact prefix matches first, even over closer fuzzy scores elsewhere', () => {
    const results = search('auth');
    // Both 'auth-service' (prefix match) and 'oauth-gateway' (contains 'auth') match,
    // but the prefix match must be ranked first.
    expect(results[0].name).toBe('auth-service');
  });

  it('matches on namespace as well as name', () => {
    const results = search('team-web');
    expect(results.map((r) => r.name)).toContain('frontend-web');
  });

  it('matches on team when present', () => {
    const results = search('web-squad');
    expect(results.map((r) => r.name)).toContain('frontend-web');
  });

  it('does not match unrelated queries', () => {
    const results = search('zzzznonexistentzzzz');
    expect(results).toHaveLength(0);
  });
});
