import { GrafanaTheme2 } from '@grafana/data';

/**
 * Semantic sparkline/chart colors resolved from the Grafana visualization palette.
 * Prefer these over hardcoded hex values so colors adapt to light/dark themes.
 */
export function sparklineColors(theme: GrafanaTheme2) {
  const c = (name: string) => theme.visualization.getColorByName(name);
  return {
    rate: c('green'),
    error: c('red'),
    /** Dimmed error color for zero-error sparklines. */
    errorDim: theme.colors.text.disabled,
    duration: c('yellow'),
  };
}

/**
 * Thread-state chart colors resolved from the Grafana visualization palette.
 */
export function threadStateColors(theme: GrafanaTheme2) {
  const c = (name: string) => theme.visualization.getColorByName(name);
  return {
    runnable: c('green'),
    timedWaiting: c('yellow'),
    waiting: c('orange'),
    blocked: c('red'),
  };
}
