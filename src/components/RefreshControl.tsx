import React, { useCallback, useEffect, useRef } from 'react';
import { Combobox, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { useAutoRefresh, REFRESH_INTERVALS } from '../utils/useInterval';
import { useUrlString } from '../utils/useUrlState';

const OFF = 'off';

/** Options for the refresh interval picker, keyed by label ("30s") for readable URLs. */
const REFRESH_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'Off', value: OFF },
  ...REFRESH_INTERVALS.map((r) => ({ label: r.label, value: r.label })),
];

interface RefreshControlProps {
  /** Called on every refresh tick. Wire this to refreshTimeRange()/refetch(). */
  onRefresh: () => void;
}

/**
 * RefreshPicker-like control for useFetch-based (non-Scene) pages.
 *
 * Persists the chosen interval in the URL (`refresh=30s`), consistent with
 * Grafana dashboards. Off by default — when off, the param is removed from
 * the URL and no timer runs. While active, shows a countdown to the next
 * refresh (same styling as the status boards).
 */
export function RefreshControl({ onRefresh }: RefreshControlProps) {
  const styles = useStyles2(getStyles);
  const [refresh, setRefresh] = useUrlString('refresh', OFF);

  // Map the URL value (e.g. "30s") to milliseconds; unknown values mean off.
  const intervalMs = REFRESH_INTERVALS.find((r) => r.label === refresh)?.value ?? 0;

  // Pages recreate their refetch callbacks on every render; route through a
  // ref so an unstable onRefresh identity never restarts the interval timer.
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  });
  const stableOnRefresh = useCallback(() => onRefreshRef.current(), []);

  const { secondsUntilRefresh } = useAutoRefresh(stableOnRefresh, intervalMs);

  return (
    <div className={styles.wrapper} data-testid="refresh-control">
      <Combobox
        aria-label="Refresh interval"
        options={REFRESH_OPTIONS}
        value={intervalMs > 0 ? refresh : OFF}
        onChange={(v) => setRefresh(v?.value ?? OFF)}
        width={10}
        prefixIcon="sync"
      />
      {intervalMs > 0 && (
        <span className={styles.countdown} data-testid="refresh-countdown">
          {secondsUntilRefresh}s
        </span>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  countdown: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
    min-width: 32px;
  `,
});
