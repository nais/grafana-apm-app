import React from 'react';
import { useTheme2 } from '@grafana/ui';
import { css } from '@emotion/css';
import { HealthStatus, healthColor, healthLabel } from '../utils/health';

interface HealthIndicatorProps {
  status: HealthStatus;
  size?: number;
  className?: string;
}

/**
 * Renders a small colored circle indicating health status.
 * Includes an aria-label for accessibility.
 */
export function HealthIndicator({ status, size = 8, className }: HealthIndicatorProps) {
  const theme = useTheme2();
  const color = healthColor(status, theme);
  const label = healthLabel(status);

  return <span className={`${dotStyle(size, color)} ${className ?? ''}`} role="img" aria-label={label} title={label} />;
}

const dotStyle = (size: number, color: string) => css`
  display: inline-block;
  width: ${size}px;
  height: ${size}px;
  border-radius: 50%;
  background-color: ${color};
  flex-shrink: 0;
`;
