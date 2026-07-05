/** Quick-range presets for the time range picker. */
export const QUICK_TIME_RANGES: Array<{ label: string; value: string }> = [
  { label: 'Last 15 minutes', value: 'now-15m' },
  { label: 'Last 30 minutes', value: 'now-30m' },
  { label: 'Last 1 hour', value: 'now-1h' },
  { label: 'Last 3 hours', value: 'now-3h' },
  { label: 'Last 6 hours', value: 'now-6h' },
  { label: 'Last 12 hours', value: 'now-12h' },
  { label: 'Last 24 hours', value: 'now-24h' },
];

/**
 * Human phrase for a from/to window, for empty states that must name the
 * actual window ("No errors in the last 3 hours"). Relative now-N ranges are
 * spelled out; anything else falls back to "the selected time range".
 */
export function describeTimeRange(from: string, to: string): string {
  if (to === 'now') {
    const m = /^now-(\d+)([mhd])$/.exec(from);
    if (m) {
      const n = Number(m[1]);
      const unit = { m: 'minute', h: 'hour', d: 'day' }[m[2] as 'm' | 'h' | 'd'];
      return `the last ${n} ${unit}${n === 1 ? '' : 's'}`;
    }
  }
  return 'the selected time range';
}
