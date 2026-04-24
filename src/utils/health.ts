import { GrafanaTheme2 } from '@grafana/data';

export type HealthStatus = 'healthy' | 'warning' | 'critical';

/** Default thresholds for service health classification. */
export const SERVICE_THRESHOLDS = {
  /** Error rate (percent) above which a service is critical. */
  errorCritical: 5,
  /** Error rate (percent) above which a service is warning. */
  errorWarning: 1,
  /** P95 latency (ms) above which a service is warning. */
  p95WarningMs: 5000,
};

/** Default thresholds for dependency health classification. */
export const DEPENDENCY_THRESHOLDS = {
  /** Error rate (fraction 0–1) above which a dependency is critical. */
  errorCritical: 0.05,
  /** Error rate (fraction 0–1) above which a dependency is warning. */
  errorWarning: 0.01,
};

/**
 * Classify service health based on error rate (as percentage) and P95 latency.
 * Thresholds: >5% error = critical, >1% = warning, >5s p95 = warning.
 */
export function getServiceHealth(errorRatePercent: number, p95Duration: number, durationUnit: string): HealthStatus {
  if (errorRatePercent > SERVICE_THRESHOLDS.errorCritical) {
    return 'critical';
  }
  if (errorRatePercent > SERVICE_THRESHOLDS.errorWarning) {
    return 'warning';
  }
  const p95Ms = durationUnit === 'ms' ? p95Duration : p95Duration * 1000;
  if (p95Ms > SERVICE_THRESHOLDS.p95WarningMs) {
    return 'warning';
  }
  return 'healthy';
}

/**
 * Classify dependency health based on error rate as a fraction (0–1).
 * Thresholds: >5% = critical, >1% = warning.
 */
export function getDependencyHealth(errorRateFraction: number): HealthStatus {
  if (errorRateFraction > DEPENDENCY_THRESHOLDS.errorCritical) {
    return 'critical';
  }
  if (errorRateFraction > DEPENDENCY_THRESHOLDS.errorWarning) {
    return 'warning';
  }
  return 'healthy';
}

/** Severity rank for sorting: critical > warning > healthy. */
export function healthSeverity(status: HealthStatus): number {
  switch (status) {
    case 'critical':
      return 2;
    case 'warning':
      return 1;
    case 'healthy':
      return 0;
  }
}

/** Map health status to a Grafana theme color string. */
export function healthColor(status: HealthStatus, theme: GrafanaTheme2): string {
  switch (status) {
    case 'critical':
      return theme.colors.error.text;
    case 'warning':
      return theme.colors.warning.text;
    case 'healthy':
      return theme.colors.success.text;
  }
}

/** Map health status to a human-readable label (for aria-label / tooltips). */
export function healthLabel(status: HealthStatus): string {
  switch (status) {
    case 'critical':
      return 'Critical';
    case 'warning':
      return 'Warning';
    case 'healthy':
      return 'Healthy';
  }
}

/**
 * Compute a delta arrow string comparing current to previous value.
 * Returns '↑', '↓', or '→' with optional formatted difference.
 * Returns null if previous value is unavailable (undefined).
 */
export function deltaArrow(current: number, previous: number | undefined): '↑' | '↓' | '→' | null {
  if (previous === undefined) {
    return null;
  }
  const diff = current - previous;
  const threshold = Math.max(Math.abs(previous) * 0.05, 0.01);
  if (diff > threshold) {
    return '↑';
  }
  if (diff < -threshold) {
    return '↓';
  }
  return '→';
}
