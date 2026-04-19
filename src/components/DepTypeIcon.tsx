import React from 'react';
import { css } from '@emotion/css';

interface DepIconProps {
  type: string;
  size?: number;
}

const ICON_CONFIGS: Record<string, { label: string; bg: string; color?: string }> = {
  postgresql: { label: 'PG', bg: '#336791' },
  mysql: { label: 'My', bg: '#4479A1' },
  redis: { label: 'Rd', bg: '#DC382D' },
  mongodb: { label: 'Mg', bg: '#47A248' },
  elasticsearch: { label: 'ES', bg: '#FEC514', color: '#000' },
  kafka: { label: 'Kf', bg: '#231F20' },
  rabbitmq: { label: 'RQ', bg: '#FF6600' },
  memcached: { label: 'Mc', bg: '#00875A' },
  external: { label: 'Ex', bg: '#6E6E6E' },
  service: { label: 'Sv', bg: '#3871DC' },
};

/**
 * Renders a small colored badge for dependency types.
 * Replaces emoji icons for consistent cross-platform rendering.
 */
export function DepTypeIcon({ type, size = 22 }: DepIconProps) {
  const config = ICON_CONFIGS[type];
  if (!config) {
    return (
      <span className={badgeStyle({ bg: '#999', color: '#fff', size })}>
        {'?'}
      </span>
    );
  }
  return (
    <span className={badgeStyle({ bg: config.bg, color: config.color ?? '#fff', size })}>
      {config.label}
    </span>
  );
}

function badgeStyle({ bg, color, size }: { bg: string; color: string; size: number }) {
  return css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: ${size}px;
    height: ${size}px;
    border-radius: 4px;
    background: ${bg};
    color: ${color};
    font-size: ${Math.round(size * 0.45)}px;
    font-weight: 700;
    letter-spacing: -0.5px;
    line-height: 1;
    flex-shrink: 0;
  `;
}

export default DepTypeIcon;
