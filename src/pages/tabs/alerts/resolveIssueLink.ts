/**
 * Best-effort resolver from a firing alert instance's labels to a related Issue
 * deep link (#32). This is deliberately conservative: it only returns a link
 * when a label CONFIDENTLY carries an issue identity, because a wrong link is
 * worse than none (the on-call engineer would chase the wrong error).
 *
 * Two identities are recognised, matching the drawer/url-contract (#62, #69):
 *   - a versioned fingerprint (`v1:9f2ab31c04d7e655`) → `issueId`
 *   - a legacy Faro/Alloy exception hash → `exceptionHash`
 *
 * Both are validated by value shape, not merely by key presence — a rule that
 * happens to carry an unrelated `hash` label won't produce a bogus link.
 */

/** Versioned fingerprint identity, e.g. `v1:9f2ab31c04d7e655` (#62). */
const FINGERPRINT_RE = /^v\d+:[0-9a-f]{6,}$/i;
/** Faro/Alloy exception hash: hex-ish, alphanumeric, reasonably long. */
const HASH_RE = /^[0-9a-f]{8,}$/i;

/** Label keys that, by convention, may carry a fingerprint identity. */
const FINGERPRINT_KEYS = ['fingerprint', 'issueid', 'issue_id'];
/** Label keys that, by convention, may carry a Faro exception hash. */
const HASH_KEYS = ['hash', 'exception_hash', 'exceptionhash'];

export type ResolvedIssueLink = { issueId: string } | { exceptionHash: string };

/**
 * Resolve alert instance labels to an issue deep-link identity, or null when no
 * label confidently carries one. Fingerprint wins over hash (it's the richer,
 * grouped identity), mirroring `serviceDeepLink` on the backend.
 */
export function resolveIssueLink(labels?: Record<string, string>): ResolvedIssueLink | null {
  if (!labels) {
    return null;
  }

  // A fingerprint can appear either under a known key or as a bare value that
  // matches the versioned-fingerprint shape (some rules label-group by it).
  for (const [key, value] of Object.entries(labels)) {
    if (!value) {
      continue;
    }
    if (FINGERPRINT_KEYS.includes(key.toLowerCase()) && FINGERPRINT_RE.test(value)) {
      return { issueId: value };
    }
    if (FINGERPRINT_RE.test(value)) {
      return { issueId: value };
    }
  }

  for (const [key, value] of Object.entries(labels)) {
    if (value && HASH_KEYS.includes(key.toLowerCase()) && HASH_RE.test(value)) {
      return { exceptionHash: value };
    }
  }

  return null;
}
