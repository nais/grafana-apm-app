import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PLUGIN_BASE_URL } from '../constants';

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
      // Preserve time range
      for (const key of ['from', 'to']) {
        const val = searchParams.get(key);
        if (val) {
          params.set(key, val);
        }
      }
      // Add extra params
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
