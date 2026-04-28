import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PLUGIN_BASE_URL } from '../constants';

/** Query params that are preserved across navigation. */
const PRESERVED_PARAMS = [
  'from',
  'to',
  'namespace',
  'environment',
  'sort',
  'dir',
  'q',
  'pageSize',
  'percentile',
  'favorites',
];

/**
 * Sanitize a query param value that may have been corrupted by the old
 * double-query-string bug (e.g., "prod-fss?sort=rate" → "prod-fss").
 */
export function sanitizeParam(value: string): string {
  const idx = value.indexOf('?');
  return idx >= 0 ? value.substring(0, idx) : value;
}

/**
 * Navigation hook that preserves time range and filter params across pages.
 * Carries: from, to, namespace, environment.
 */
export function useAppNavigate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const appNavigate = useCallback(
    (path: string, extraParams?: Record<string, string>) => {
      const params = new URLSearchParams();
      for (const key of PRESERVED_PARAMS) {
        const raw = searchParams.get(key);
        const val = raw ? sanitizeParam(raw) : null;
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
      navigate(`${PLUGIN_BASE_URL}/${path}${qs ? `?${qs}` : ''}`);
    },
    [navigate, searchParams]
  );

  return appNavigate;
}
