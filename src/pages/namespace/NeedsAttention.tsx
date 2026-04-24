import React, { useMemo } from 'react';
import { Icon, useStyles2, useTheme2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { ServiceSummary } from '../../api/client';
import { getServiceHealth, healthSeverity, deltaArrow } from '../../utils/health';
import { formatDuration, formatRate } from '../../utils/format';
import { sparklineColors } from '../../utils/colors';
import { getSectionStyles } from '../../utils/styles';
import { Sparkline } from '../../components/Sparkline';
import { HealthIndicator } from '../../components/HealthIndicator';

const MAX_ITEMS = 5;

interface NeedsAttentionProps {
  services: ServiceSummary[];
  sparklineMap?: Map<string, ServiceSummary>;
  previousMap?: Map<string, ServiceSummary>;
  onServiceClick: (namespace: string, service: string, environment?: string) => void;
}

interface AttentionItem {
  service: ServiceSummary;
  health: ReturnType<typeof getServiceHealth>;
  severity: number;
  impact: number;
  previous?: ServiceSummary;
}

export function NeedsAttention({ services, sparklineMap, previousMap, onServiceClick }: NeedsAttentionProps) {
  const styles = useStyles2(getStyles);
  const sectionStyles = useStyles2(getSectionStyles);
  const theme = useTheme2();
  const sc = sparklineColors(theme);

  const items = useMemo(() => {
    const unhealthy: AttentionItem[] = [];
    for (const svc of services) {
      const health = getServiceHealth(svc.errorRate, svc.p95Duration, svc.durationUnit);
      if (health === 'healthy') {
        continue;
      }
      const key = `${svc.namespace}/${svc.name}/${svc.environment ?? ''}`;
      unhealthy.push({
        service: svc,
        health,
        severity: healthSeverity(health),
        impact: svc.rate * (svc.errorRate / 100),
        previous: previousMap?.get(key),
      });
    }
    // Sort: severity desc, then impact desc
    unhealthy.sort((a, b) => b.severity - a.severity || b.impact - a.impact);
    return unhealthy.slice(0, MAX_ITEMS);
  }, [services, previousMap]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className={sectionStyles.section}>
      <h3 className={sectionStyles.sectionTitle}>
        <Icon name="exclamation-triangle" size="md" /> Needs Attention
      </h3>
      <div className={styles.list}>
        {items.map((item) => {
          const { service: svc, health, previous } = item;
          const sparkKey = `${svc.namespace}/${svc.name}/${svc.environment ?? ''}`;
          const spark = sparklineMap?.get(sparkKey);
          const errArrow = deltaArrow(svc.errorRate, previous?.errorRate);
          const p95Arrow = deltaArrow(svc.p95Duration, previous?.p95Duration);

          return (
            <div
              key={`${svc.name}/${svc.environment ?? ''}`}
              className={styles.item}
              onClick={() => onServiceClick(svc.namespace, svc.name, svc.environment)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  onServiceClick(svc.namespace, svc.name, svc.environment);
                }
              }}
            >
              <div className={styles.itemHeader}>
                <HealthIndicator status={health} size={10} />
                <span className={styles.serviceName}>{svc.name}</span>
                {svc.environment && <span className={styles.envBadge}>{svc.environment}</span>}
                {spark?.errorSeries && spark.errorSeries.length >= 2 && (
                  <div className={styles.itemSparkline}>
                    <Sparkline data={spark.errorSeries.map((p) => p.v)} color={sc.error} width={80} height={24} />
                  </div>
                )}
              </div>
              <div className={styles.itemMetrics}>
                <span className={styles.metric}>
                  err: {svc.errorRate.toFixed(1)}%{errArrow && <span className={styles.arrow}> {errArrow}</span>}
                </span>
                <span className={styles.metric}>
                  p95: {formatDuration(svc.p95Duration, svc.durationUnit)}
                  {p95Arrow && <span className={styles.arrow}> {p95Arrow}</span>}
                </span>
                <span className={styles.metricSecondary}>{formatRate(svc.rate)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  list: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: ${theme.spacing(1)};
  `,
  item: css`
    padding: ${theme.spacing(1.5)};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    cursor: pointer;
    transition: background 0.15s ease;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.75)};
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  itemHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
  `,
  itemSparkline: css`
    flex-shrink: 0;
    margin-left: auto;
  `,
  serviceName: css`
    font-weight: ${theme.typography.fontWeightMedium};
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.text.primary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  envBadge: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    background: ${theme.colors.background.canvas};
    padding: 1px ${theme.spacing(0.75)};
    border-radius: ${theme.shape.radius.default};
    flex-shrink: 0;
  `,
  itemMetrics: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(2)};
    flex-wrap: wrap;
  `,
  metric: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.primary};
    font-variant-numeric: tabular-nums;
  `,
  metricSecondary: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
  `,
  arrow: css`
    color: ${theme.colors.text.secondary};
  `,
});
