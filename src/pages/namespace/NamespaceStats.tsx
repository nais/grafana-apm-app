import React from 'react';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { ServiceSummary } from '../../api/client';
import { formatDuration } from '../../utils/format';

interface NamespaceStatsProps {
  services: ServiceSummary[];
}

export function NamespaceStats({ services }: NamespaceStatsProps) {
  const styles = useStyles2(getStyles);

  const serviceCount = services.length;
  const totalRate = services.reduce((sum, s) => sum + s.rate, 0);

  // Weighted-average error rate: sum(rate * errorRate) / sum(rate)
  const weightedErrors = services.reduce((sum, s) => sum + s.rate * (s.errorRate / 100), 0);
  const avgErrorRate = totalRate > 0 ? (weightedErrors / totalRate) * 100 : 0;

  // Max P95 across all services
  const maxP95 = services.reduce((max, s) => Math.max(max, s.p95Duration), 0);
  const durationUnit = services[0]?.durationUnit ?? 'ms';

  return (
    <div className={styles.grid}>
      <StatCard title="Services" value={String(serviceCount)} />
      <StatCard title="Rate" value={`${totalRate.toFixed(1)} req/s`} />
      <StatCard
        title="Error Rate"
        value={`${avgErrorRate.toFixed(2)}%`}
        color={avgErrorRate > 5 ? 'critical' : avgErrorRate > 1 ? 'warning' : undefined}
      />
      <StatCard title="Max P95" value={formatDuration(maxP95, durationUnit)} />
    </div>
  );
}

function StatCard({ title, value, color }: { title: string; value: string; color?: 'warning' | 'critical' }) {
  const styles = useStyles2(getStyles);
  const valueClass =
    color === 'critical' ? styles.valueCritical : color === 'warning' ? styles.valueWarning : styles.value;

  return (
    <div className={styles.card}>
      <span className={styles.cardTitle}>{title}</span>
      <span className={valueClass}>{value}</span>
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
  `,
  cardTitle: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin-bottom: ${theme.spacing(0.5)};
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
});
