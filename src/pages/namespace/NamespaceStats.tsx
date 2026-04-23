import React, { useMemo } from 'react';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { ServiceSummary } from '../../api/client';
import { getServiceHealth } from '../../utils/health';
import { Sparkline } from '../../components/Sparkline';

interface NamespaceStatsProps {
  services: ServiceSummary[];
  previousMap?: Map<string, ServiceSummary>;
  sparklineMap?: Map<string, ServiceSummary>;
}

/** Aggregate per-service sparklines by timestamp into a single namespace-level series. */
function aggregateSparklines(
  services: ServiceSummary[],
  sparklineMap: Map<string, ServiceSummary> | undefined,
  field: 'rateSeries'
): number[] {
  if (!sparklineMap || sparklineMap.size === 0) {
    return [];
  }

  // Collect all data points grouped by timestamp
  const byTimestamp = new Map<number, number>();
  for (const svc of services) {
    const key = `${svc.namespace}/${svc.name}/${svc.environment ?? ''}`;
    const spark = sparklineMap.get(key);
    const series = spark?.[field];
    if (!series) {
      continue;
    }
    for (const pt of series) {
      byTimestamp.set(pt.t, (byTimestamp.get(pt.t) ?? 0) + pt.v);
    }
  }

  if (byTimestamp.size === 0) {
    return [];
  }

  // Sort by timestamp and return values
  const sorted = Array.from(byTimestamp.entries()).sort((a, b) => a[0] - b[0]);
  return sorted.map(([, v]) => v);
}

export function NamespaceStats({ services, previousMap, sparklineMap }: NamespaceStatsProps) {
  const styles = useStyles2(getStyles);

  const { serviceCount, totalRate, withErrors, healthyCount, prevWithErrors, prevHealthy } = useMemo(() => {
    let errors = 0;
    let healthy = 0;
    let rate = 0;
    for (const s of services) {
      rate += s.rate;
      const h = getServiceHealth(s.errorRate, s.p95Duration, s.durationUnit);
      if (s.errorRate > 0) {
        errors++;
      }
      if (h === 'healthy') {
        healthy++;
      }
    }

    let pErrors: number | undefined;
    let pHealthy: number | undefined;
    if (previousMap) {
      let pe = 0;
      let ph = 0;
      for (const s of previousMap.values()) {
        const h = getServiceHealth(s.errorRate, s.p95Duration, s.durationUnit);
        if (s.errorRate > 0) {
          pe++;
        }
        if (h === 'healthy') {
          ph++;
        }
      }
      pErrors = pe;
      pHealthy = ph;
    }

    return {
      serviceCount: services.length,
      totalRate: rate,
      withErrors: errors,
      healthyCount: healthy,
      prevWithErrors: pErrors,
      prevHealthy: pHealthy,
    };
  }, [services, previousMap]);

  const rateSpark = useMemo(() => aggregateSparklines(services, sparklineMap, 'rateSeries'), [services, sparklineMap]);

  return (
    <div className={styles.grid}>
      <StatCard title="Services" value={String(serviceCount)} />
      <StatCard title="Rate" value={`${totalRate.toFixed(1)} req/s`} sparkData={rateSpark} sparkColor="#73BF69" />
      <StatCard
        title="With Errors"
        value={`${withErrors} of ${serviceCount}`}
        color={withErrors > 0 ? 'critical' : undefined}
        delta={prevWithErrors !== undefined ? `was ${prevWithErrors}` : undefined}
      />
      <StatCard
        title="Healthy"
        value={`${healthyCount} of ${serviceCount}`}
        color={healthyCount < serviceCount ? 'warning' : 'success'}
        delta={prevHealthy !== undefined ? `was ${prevHealthy}` : undefined}
      />
    </div>
  );
}

interface StatCardProps {
  title: string;
  value: string;
  color?: 'warning' | 'critical' | 'success';
  delta?: string;
  sparkData?: number[];
  sparkColor?: string;
}

function StatCard({ title, value, color, delta, sparkData, sparkColor }: StatCardProps) {
  const styles = useStyles2(getStyles);
  const valueClass =
    color === 'critical'
      ? styles.valueCritical
      : color === 'warning'
        ? styles.valueWarning
        : color === 'success'
          ? styles.valueSuccess
          : styles.value;

  return (
    <div className={styles.card}>
      <span className={styles.cardTitle}>{title}</span>
      <span className={valueClass}>{value}</span>
      {sparkData && sparkData.length >= 2 && (
        <Sparkline data={sparkData} color={sparkColor ?? '#73BF69'} width={100} height={20} />
      )}
      {delta && <span className={styles.delta}>{delta}</span>}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: ${theme.spacing(2)};
    margin-bottom: ${theme.spacing(3)};
    @media (max-width: 768px) {
      grid-template-columns: repeat(2, 1fr);
    }
  `,
  card: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: ${theme.spacing(2)};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    gap: ${theme.spacing(0.5)};
  `,
  cardTitle: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `,
  value: css`
    font-size: ${theme.typography.h3.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
  `,
  valueWarning: css`
    font-size: ${theme.typography.h3.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.warning.text};
  `,
  valueCritical: css`
    font-size: ${theme.typography.h3.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.error.text};
  `,
  valueSuccess: css`
    font-size: ${theme.typography.h3.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.success.text};
  `,
  delta: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
  `,
});
