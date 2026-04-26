import React from 'react';
import { useTheme2, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { HealthStatus, healthColor, healthLabel, deltaArrow } from '../utils/health';
import { formatRate, formatErrorRate, formatDuration } from '../utils/format';
import { sparklineColors } from '../utils/colors';
import { Sparkline } from './Sparkline';
import { ServiceSummary } from '../api/client';

export type CardStatus = HealthStatus | 'noData';

export interface StatusCardProps {
  service: ServiceSummary;
  status: CardStatus;
  previous?: ServiceSummary;
  sparkline?: ServiceSummary;
  /** Timestamp (ms) when the service was last seen — only used for noData cards. */
  lastSeen?: number;
  onClick?: () => void;
}

function cardBackground(status: CardStatus, theme: GrafanaTheme2): string {
  switch (status) {
    case 'healthy':
      return theme.isDark ? 'rgba(55, 135, 55, 0.12)' : 'rgba(55, 135, 55, 0.08)';
    case 'warning':
      return theme.isDark ? 'rgba(200, 150, 30, 0.14)' : 'rgba(200, 150, 30, 0.08)';
    case 'critical':
      return theme.isDark ? 'rgba(200, 50, 50, 0.18)' : 'rgba(200, 50, 50, 0.10)';
    case 'noData':
      return theme.isDark ? 'rgba(120, 120, 120, 0.10)' : 'rgba(120, 120, 120, 0.06)';
  }
}

function cardBorder(status: CardStatus, theme: GrafanaTheme2): string {
  switch (status) {
    case 'healthy':
      return theme.colors.success.border;
    case 'warning':
      return theme.colors.warning.border;
    case 'critical':
      return theme.colors.error.border;
    case 'noData':
      return theme.colors.border.medium;
  }
}

function statusLabel(status: CardStatus): string {
  if (status === 'noData') {
    return 'No Data';
  }
  return healthLabel(status);
}

function formatLastSeen(lastSeen: number): string {
  const diffMs = Date.now() - lastSeen;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes === 1) {
    return '1 min ago';
  }
  return `${minutes} min ago`;
}

export function StatusCard({ service, status, previous, sparkline, lastSeen, onClick }: StatusCardProps) {
  const theme = useTheme2();
  const styles = useStyles2(getStyles);
  const sc = sparklineColors(theme);

  const bg = cardBackground(status, theme);
  const border = cardBorder(status, theme);
  const indicatorColor = status === 'noData' ? theme.colors.text.disabled : healthColor(status, theme);

  const errArrow = deltaArrow(service.errorRate, previous?.errorRate);
  const p95Arrow = deltaArrow(service.p95Duration, previous?.p95Duration);
  const rateArrow = deltaArrow(service.rate, previous?.rate);

  return (
    <div
      className={styles.card}
      style={{ background: bg, borderColor: border }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onClick?.();
        }
      }}
      aria-label={`${service.name}: ${statusLabel(status)}`}
    >
      {/* Status indicator dot */}
      <div className={styles.indicatorRow}>
        <span className={styles.indicator} style={{ backgroundColor: indicatorColor }} aria-hidden="true" />
        {service.environment && <span className={styles.envBadge}>{service.environment}</span>}
      </div>

      {/* Service name */}
      <div className={styles.serviceName}>{service.name}</div>

      {status === 'noData' ? (
        <div className={styles.noData}>
          <span className={styles.noDataLabel}>NO DATA</span>
          {lastSeen && <span className={styles.lastSeen}>seen {formatLastSeen(lastSeen)}</span>}
        </div>
      ) : (
        <>
          {/* Metrics row */}
          <div className={styles.metricsGrid}>
            <div className={styles.metricItem}>
              <span className={styles.metricValue}>
                {formatRate(service.rate)}
                {rateArrow && <span className={styles.arrow}> {rateArrow}</span>}
              </span>
            </div>
            <div className={styles.metricItem}>
              <span className={styles.metricValue}>
                {formatErrorRate(service.errorRate)} err
                {errArrow && <span className={styles.arrow}> {errArrow}</span>}
              </span>
            </div>
            <div className={styles.metricItem}>
              <span className={styles.metricValue}>
                p95: {formatDuration(service.p95Duration, service.durationUnit)}
                {p95Arrow && <span className={styles.arrow}> {p95Arrow}</span>}
              </span>
            </div>
          </div>

          {/* Optional sparkline */}
          {sparkline?.errorSeries && sparkline.errorSeries.length >= 2 && (
            <div className={styles.sparklineRow}>
              <Sparkline data={sparkline.errorSeries.map((p) => p.v)} color={sc.error} width={160} height={28} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  card: css`
    display: flex;
    flex-direction: column;
    padding: ${theme.spacing(2)};
    border: 2px solid;
    border-radius: ${theme.shape.radius.default};
    cursor: pointer;
    transition:
      transform 0.1s ease,
      box-shadow 0.15s ease;
    gap: ${theme.spacing(0.75)};
    min-height: 140px;
    &:hover {
      transform: translateY(-1px);
      box-shadow: ${theme.shadows.z2};
    }
  `,
  indicatorRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  indicator: css`
    width: 14px;
    height: 14px;
    border-radius: 50%;
    flex-shrink: 0;
  `,
  envBadge: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    background: ${theme.colors.background.canvas};
    padding: 1px ${theme.spacing(0.75)};
    border-radius: ${theme.shape.radius.default};
  `,
  serviceName: css`
    font-weight: ${theme.typography.fontWeightBold};
    font-size: clamp(1.1rem, 2vw, 1.5rem);
    color: ${theme.colors.text.primary};
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    word-break: break-word;
  `,
  metricsGrid: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.25)};
    margin-top: auto;
  `,
  metricItem: css`
    display: flex;
    align-items: baseline;
    gap: ${theme.spacing(0.5)};
  `,
  metricValue: css`
    font-size: clamp(0.85rem, 1.3vw, 1.05rem);
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.text.primary};
  `,
  arrow: css`
    color: ${theme.colors.text.secondary};
  `,
  sparklineRow: css`
    margin-top: ${theme.spacing(0.5)};
  `,
  noData: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
    margin-top: auto;
  `,
  noDataLabel: css`
    font-size: clamp(0.9rem, 1.5vw, 1.15rem);
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    letter-spacing: 1px;
  `,
  lastSeen: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.disabled};
  `,
});
