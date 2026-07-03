import Fuse, { IFuseOptions } from 'fuse.js';

/** Minimal shape required for fuzzy service search. */
export interface SearchableService {
  name: string;
  namespace: string;
  team?: string;
}

function fuseOptions<T extends SearchableService>(): IFuseOptions<T> {
  return {
    keys: ['name', 'namespace', 'team'],
    threshold: 0.4, // low enough that single-letter queries don't match everything
    ignoreLocation: true, // match tokens anywhere in the string, not just near the start
    includeScore: true,
  };
}

/**
 * Build a Fuse.js search index for a service list. Indexing is the expensive
 * part of a fuzzy search, so callers should memoize this on the service list
 * (e.g. `useMemo(() => createServiceSearchIndex(services), [services])`) so
 * typing in the search box doesn't re-index on every keystroke.
 */
export function createServiceSearchIndex<T extends SearchableService>(services: T[]): Fuse<T> {
  return new Fuse(services, fuseOptions<T>());
}

/**
 * Fuzzy-match `services` against `query` using a prebuilt Fuse index
 * (see `createServiceSearchIndex`), ranked by relevance. An empty (or
 * whitespace-only) query returns `services` unchanged, preserving the
 * caller's existing order.
 *
 * Exact name-prefix matches are boosted above all other matches regardless
 * of fuzzy score, so typing the start of a service name always surfaces it
 * first.
 */
export function searchServices<T extends SearchableService>(services: T[], query: string, index: Fuse<T>): T[] {
  const q = query.trim();
  if (!q) {
    return services;
  }
  const lowerQ = q.toLowerCase();
  return index
    .search(q)
    .sort((a, b) => {
      const aPrefix = a.item.name.toLowerCase().startsWith(lowerQ) ? 0 : 1;
      const bPrefix = b.item.name.toLowerCase().startsWith(lowerQ) ? 0 : 1;
      if (aPrefix !== bPrefix) {
        return aPrefix - bPrefix;
      }
      return (a.score ?? 0) - (b.score ?? 0);
    })
    .map((r) => r.item);
}
