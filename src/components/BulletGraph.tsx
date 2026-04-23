import React from 'react';
import { Icon, useTheme2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';

export interface BulletGraphThreshold {
  value: number;
  color: string;
}

export interface BulletGraphProps {
  /** Current measured value (null = no data). */
  value: number | null;
  /** Ordered threshold steps, e.g. [{value:0,color:'green'},{value:2500,color:'orange'},{value:4000,color:'red'}]. */
  thresholds: BulletGraphThreshold[];
  /** Scale maximum (default: 1.25× highest threshold). */
  max?: number;
  /** Short label, e.g. "LCP". */
  label: string;
  /** Full description, e.g. "Largest Contentful Paint". */
  description?: string;
  /** Tooltip text for the help icon. */
  tooltip?: string;
  /** Display unit, e.g. "ms". */
  unit?: string;
  /** Decimal places for the value display. */
  decimals?: number;
}

/** Determine the qualitative rating for a value against thresholds. */
export function getRating(value: number, thresholds: BulletGraphThreshold[]): { label: string; color: string } {
  if (thresholds.length < 3) {
    return { label: '', color: 'green' };
  }
  if (value < thresholds[1].value) {
    return { label: 'Good', color: thresholds[0].color };
  }
  if (value < thresholds[2].value) {
    return { label: 'Needs improvement', color: thresholds[1].color };
  }
  return { label: 'Poor', color: thresholds[2].color };
}

/** Format a numeric value with optional unit and fixed decimals. */
export function formatVitalValue(value: number, unit?: string, decimals = 0): string {
  const formatted = value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return unit ? `${formatted} ${unit}` : formatted;
}

/** Format a threshold tick label with unit. */
export function formatTick(value: number, unit?: string): string {
  if (!unit) {
    return String(value);
  }
  // Compact: 2500 ms → "2.50s", 800 ms → "800ms"
  if (unit === 'ms' && value >= 1000) {
    return `${(value / 1000).toFixed(2)}s`;
  }
  return `${value}${unit}`;
}

/**
 * Bullet graph card — a compact vertical card showing a measured value against
 * qualitative ranges (Stephen Few design). Used for Core Web Vitals.
 */
export function BulletGraph({
  value,
  thresholds,
  max,
  label,
  description,
  tooltip,
  unit,
  decimals = 0,
}: BulletGraphProps) {
  const theme = useTheme2();

  if (thresholds.length < 3) {
    return null;
  }

  const scaleMax = max ?? thresholds[2].value * 1.25;
  const resolve = (name: string) => theme.visualization.getColorByName(name);

  const band1Pct = (thresholds[1].value / scaleMax) * 100;
  const band2Pct = ((thresholds[2].value - thresholds[1].value) / scaleMax) * 100;
  const band3Pct = 100 - band1Pct - band2Pct;

  const markerPct = value !== null ? Math.max(0, Math.min((value / scaleMax) * 100, 100)) : null;

  const rating = value !== null ? getRating(value, thresholds) : null;
  const ratingColor = rating ? resolve(rating.color) : undefined;
  const styles = getStyles(theme);

  return (
    <div className={styles.card} data-testid={`bullet-graph-${label}`}>
      {/* Row 1: abbreviation + help icon */}
      <div className={styles.titleRow}>
        <span className={styles.abbreviation}>{label}</span>
        {tooltip && (
          <span className={styles.helpIcon} title={tooltip}>
            <Icon name="question-circle" size="sm" />
          </span>
        )}
      </div>

      {/* Row 2: full metric name */}
      {description && <span className={styles.metricName}>{description}</span>}

      {/* Row 3: large value */}
      <div className={styles.valueRow}>
        {value !== null ? (
          <span className={styles.bigValue} style={{ color: ratingColor }}>
            {formatVitalValue(value, unit, decimals)}
          </span>
        ) : (
          <span className={styles.noData}>—</span>
        )}
      </div>

      {/* Row 3b: rating label (always on its own line to prevent layout shift) */}
      {rating && (
        <span className={styles.ratingText} style={{ color: ratingColor }}>
          ({rating.label})
        </span>
      )}

      {/* Row 4: colored bar + marker */}
      <div className={styles.barOuter}>
        <div className={styles.barInner}>
          <div style={{ width: `${band1Pct}%`, backgroundColor: resolve(thresholds[0].color) }} />
          <div style={{ width: `${band2Pct}%`, backgroundColor: resolve(thresholds[1].color) }} />
          <div style={{ width: `${band3Pct}%`, backgroundColor: resolve(thresholds[2].color) }} />
        </div>
        {markerPct !== null && (
          <div className={styles.marker} style={{ left: `${markerPct}%` }} data-testid="bullet-marker" />
        )}
      </div>

      {/* Row 5: threshold tick labels */}
      <div className={styles.ticks}>
        <span className={styles.tick} style={{ left: `${band1Pct}%` }}>
          {formatTick(thresholds[1].value, unit)}
        </span>
        <span className={styles.tick} style={{ left: `${band1Pct + band2Pct}%` }}>
          {formatTick(thresholds[2].value, unit)}
        </span>
      </div>
    </div>
  );
}

function getStyles(theme: GrafanaTheme2) {
  return {
    card: css({
      display: 'flex',
      flexDirection: 'column' as const,
      gap: theme.spacing(0.5),
      padding: theme.spacing(2),
      background: theme.colors.background.secondary,
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
      minWidth: 0,
    }),
    titleRow: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(0.5),
    }),
    abbreviation: css({
      fontWeight: theme.typography.fontWeightBold,
      fontSize: theme.typography.h4.fontSize,
      color: theme.colors.text.primary,
      lineHeight: 1.2,
    }),
    helpIcon: css({
      color: theme.colors.text.secondary,
      cursor: 'help',
      display: 'flex',
    }),
    metricName: css({
      fontSize: theme.typography.bodySmall.fontSize,
      color: theme.colors.text.secondary,
      lineHeight: 1.3,
    }),
    valueRow: css({
      marginTop: theme.spacing(0.5),
    }),
    bigValue: css({
      fontWeight: theme.typography.fontWeightBold,
      fontSize: theme.typography.h3.fontSize,
      fontVariantNumeric: 'tabular-nums',
      lineHeight: 1.2,
    }),
    ratingText: css({
      fontSize: theme.typography.bodySmall.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
      whiteSpace: 'nowrap' as const,
    }),
    noData: css({
      fontSize: theme.typography.h3.fontSize,
      color: theme.colors.text.disabled,
    }),
    barOuter: css({
      position: 'relative' as const,
      height: 12,
      marginTop: theme.spacing(0.5),
    }),
    barInner: css({
      display: 'flex',
      width: '100%',
      height: '100%',
      borderRadius: theme.shape.radius.default,
      overflow: 'hidden',
      opacity: 0.8,
    }),
    marker: css({
      position: 'absolute' as const,
      bottom: -8,
      transform: 'translateX(-50%)',
      width: 0,
      height: 0,
      borderLeft: '6px solid transparent',
      borderRight: '6px solid transparent',
      borderTop: `8px solid ${theme.colors.text.primary}`,
    }),
    ticks: css({
      position: 'relative' as const,
      height: theme.spacing(2.5),
      fontSize: theme.typography.bodySmall.fontSize,
      color: theme.colors.text.secondary,
      marginTop: theme.spacing(0.25),
    }),
    tick: css({
      position: 'absolute' as const,
      transform: 'translateX(-50%)',
      whiteSpace: 'nowrap' as const,
    }),
  };
}
