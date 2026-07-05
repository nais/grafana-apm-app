import { resolveIssueLink } from './resolveIssueLink';

describe('resolveIssueLink (#32 label→issue resolver)', () => {
  it('resolves a fingerprint under a known key to an issueId', () => {
    expect(resolveIssueLink({ fingerprint: 'v1:9f2ab31c04d7e655', service: 'orders' })).toEqual({
      issueId: 'v1:9f2ab31c04d7e655',
    });
  });

  it('resolves a bare versioned-fingerprint value under any key', () => {
    // Some rules label-group by fingerprint under a non-standard key; the
    // versioned shape is distinctive enough to trust.
    expect(resolveIssueLink({ grp: 'v2:aabbccddee', endpoint: '/checkout' })).toEqual({ issueId: 'v2:aabbccddee' });
  });

  it('resolves a Faro exception hash to an exceptionHash', () => {
    expect(resolveIssueLink({ hash: 'a1b2c3d4e5f6', service: 'orders' })).toEqual({ exceptionHash: 'a1b2c3d4e5f6' });
  });

  it('prefers a fingerprint over a hash when both are present', () => {
    expect(resolveIssueLink({ fingerprint: 'v1:deadbeefcafe', hash: 'a1b2c3d4e5f6' })).toEqual({
      issueId: 'v1:deadbeefcafe',
    });
  });

  it('returns null with no confident match — an ordinary label set', () => {
    // The most important case: never emit a wrong link. Plain infra labels
    // (endpoint, severity, service) carry no issue identity.
    expect(resolveIssueLink({ endpoint: '/checkout', severity: 'critical', service: 'orders' })).toBeNull();
  });

  it('returns null for a short/non-hex value under a hash key', () => {
    // Guards against a bogus link: a `hash` label that isn't hash-shaped.
    expect(resolveIssueLink({ hash: 'prod' })).toBeNull();
    expect(resolveIssueLink({ hash: 'v1' })).toBeNull();
  });

  it('returns null for undefined / empty labels', () => {
    expect(resolveIssueLink(undefined)).toBeNull();
    expect(resolveIssueLink({})).toBeNull();
  });
});
