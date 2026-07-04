import React from 'react';
import { useStyles2, Icon, LoadingPlaceholder } from '@grafana/ui';
import { GrafanaTheme2, IconName } from '@grafana/data';
import { css } from '@emotion/css';
import { HealthSummary as HealthData } from '../../../api/client';
import { formatRate, formatErrorRate, formatDuration } from '../../../utils/format';
import { computeDelta, DeltaResult, DeltaPolarity } from './healthDelta';

interface HealthHeaderRowProps {
  health: HealthData | null;
  loading: boolean;
}

/**
 * Instant health signal (#35): the RED trio as big numbers, each with a
 * delta vs the previous period so "is this normal?" doesn't require
 * eyeballing the timeseries below. Reuses the `health` prop's
 * rate/errorRate/p95Duration + prevRate/prevErrorRate/prevP95Duration —
 * the same comparison the backend already computes for the "Attention
 * needed" section — rather than a second, independently-windowed set of
 * PromQL offset queries that could disagree with it.
 */
export function HealthHeaderRow({ health, loading }: HealthHeaderRowProps) {
  const styles = useStyles2(getStyles);

  if (!health) {
    if (loading) {
      return (
        <div className={styles.row}>
          <LoadingPlaceholder text="Loading health…" />
        </div>
      );
    }
    return null;
  }

  const rateDelta = computeDelta(health.rate, health.prevRate, 'neutral');
  const errorDelta = computeDelta(health.errorRate, health.prevErrorRate, 'lowerIsBetter');
  const durationDelta = computeDelta(health.p95Duration, health.prevP95Duration, 'lowerIsBetter');

  return (
    <div className={styles.row}>
      <HealthStat label="Request rate" value={formatRate(health.rate)} delta={rateDelta} />
      <HealthStat label="Error rate" value={formatErrorRate(health.errorRate)} delta={errorDelta} />
      <HealthStat
        label="P95 latency"
        value={formatDuration(health.p95Duration, health.durationUnit)}
        delta={durationDelta}
      />
    </div>
  );
}

interface HealthStatProps {
  label: string;
  value: string;
  delta: DeltaResult;
}

function HealthStat({ label, value, delta }: HealthStatProps) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.tile}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
      <DeltaLine delta={delta} />
    </div>
  );
}

const DIRECTION_ICON: Record<DeltaResult['direction'], IconName> = {
  increase: 'arrow-up',
  decrease: 'arrow-down',
  flat: 'minus',
};

function severityClassName(styles: ReturnType<typeof getStyles>, severity: DeltaResult['severity']): string {
  switch (severity) {
    case 'bad':
      return styles.deltaBad;
    case 'warn':
      return styles.deltaWarn;
    case 'good':
      return styles.deltaGood;
    default:
      return styles.deltaNeutral;
  }
}

function DeltaLine({ delta }: { delta: DeltaResult }) {
  const styles = useStyles2(getStyles);
  const className = severityClassName(styles, delta.severity);

  if (delta.pct === null) {
    return <span className={className}>no previous-period data</span>;
  }

  const pctLabel = `${delta.pct >= 0 ? '+' : ''}${(delta.pct * 100).toFixed(1)}%`;
  return (
    <span className={className}>
      <Icon name={DIRECTION_ICON[delta.direction]} size="sm" /> {pctLabel} vs previous period
    </span>
  );
}

/** Exposed for testing polarity assignment without re-deriving it in the test file. */
export const HEALTH_STAT_POLARITY: Record<'rate' | 'errorRate' | 'p95Duration', DeltaPolarity> = {
  rate: 'neutral',
  errorRate: 'lowerIsBetter',
  p95Duration: 'lowerIsBetter',
};

const getStyles = (theme: GrafanaTheme2) => ({
  row: css`
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: ${theme.spacing(2)};
    margin-bottom: ${theme.spacing(2)};
    @media (max-width: 768px) {
      grid-template-columns: 1fr;
    }
  `,
  tile: css`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: ${theme.spacing(0.5)};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1.5)} ${theme.spacing(2)};
  `,
  label: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `,
  value: css`
    font-size: ${theme.typography.h2.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
  `,
  deltaNeutral: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
  `,
  deltaGood: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.success.text};
    font-variant-numeric: tabular-nums;
  `,
  deltaWarn: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.warning.text};
    font-variant-numeric: tabular-nums;
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  deltaBad: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.error.text};
    font-variant-numeric: tabular-nums;
    font-weight: ${theme.typography.fontWeightMedium};
  `,
});
