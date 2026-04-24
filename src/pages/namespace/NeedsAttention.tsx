import React, { useMemo } from 'react';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { ServiceSummary } from '../../api/client';
import { getServiceHealth, healthSeverity, healthColor, healthEmoji, deltaArrow } from '../../utils/health';
import { formatDuration, formatRate } from '../../utils/format';
import { sparklineColors } from '../../utils/colors';
import { getSectionStyles } from '../../utils/styles';
import { Sparkline } from '../../components/Sparkline';

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
      <h3 className={sectionStyles.sectionTitle}>⚠ Needs Attention</h3>
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
                <span className={styles.healthDot} style={{ color: healthColor(health, theme) }}>
                  {healthEmoji(health)}
                </span>
                <span className={styles.serviceName}>{svc.name}</span>
                {svc.environment && <span className={styles.envBadge}>{svc.environment}</span>}
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
                {spark?.errorSeries && spark.errorSeries.length >= 2 && (
                  <Sparkline data={spark.errorSeries.map((p) => p.v)} color={sc.error} width={60} height={18} />
                )}
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
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: ${theme.colors.border.weak};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    overflow: hidden;
  `,
  item: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
    background: ${theme.colors.background.secondary};
    cursor: pointer;
    transition: background 0.15s ease;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  itemHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
  `,
  healthDot: css`
    font-size: 12px;
    line-height: 1;
    flex-shrink: 0;
  `,
  serviceName: css`
    font-weight: ${theme.typography.fontWeightMedium};
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.text.primary};
  `,
  envBadge: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    background: ${theme.colors.background.canvas};
    padding: 1px ${theme.spacing(0.75)};
    border-radius: ${theme.shape.radius.default};
  `,
  itemMetrics: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(2)};
    padding-left: 22px;
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
