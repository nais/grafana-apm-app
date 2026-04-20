import React from 'react';
import { css } from '@emotion/css';
import { Icon } from '@grafana/ui';
import type { IconName } from '@grafana/data';

interface DepIconProps {
  type: string;
  size?: number;
}

const ICON_CONFIGS: Record<string, { icon: IconName; displayName: string; bg: string; color?: string }> = {
  postgresql: { icon: 'database', displayName: 'PostgreSQL', bg: '#336791' },
  oracle: { icon: 'database', displayName: 'Oracle', bg: '#F80000' },
  mysql: { icon: 'database', displayName: 'MySQL', bg: '#4479A1' },
  redis: { icon: 'database', displayName: 'Redis', bg: '#DC382D' },
  mongodb: { icon: 'database', displayName: 'MongoDB', bg: '#47A248' },
  db2: { icon: 'database', displayName: 'DB2', bg: '#054ADA' },
  opensearch: { icon: 'search', displayName: 'OpenSearch', bg: '#005EB8' },
  h2: { icon: 'database', displayName: 'H2', bg: '#0945B5' },
  database: { icon: 'database', displayName: 'Database', bg: '#8B6914' },
  elasticsearch: { icon: 'search', displayName: 'Elasticsearch', bg: '#FEC514', color: '#000' },
  kafka: { icon: 'exchange-alt', displayName: 'Kafka', bg: '#231F20' },
  messaging: { icon: 'envelope', displayName: 'Messaging', bg: '#FF6600' },
  rabbitmq: { icon: 'envelope', displayName: 'RabbitMQ', bg: '#FF6600' },
  memcached: { icon: 'database', displayName: 'Memcached', bg: '#00875A' },
  external: { icon: 'globe', displayName: 'External', bg: '#6E6E6E' },
  service: { icon: 'cube', displayName: 'Service', bg: '#3871DC' },
  valkey: { icon: 'database', displayName: 'Valkey', bg: '#7B68EE' },
  bigquery: { icon: 'table', displayName: 'BigQuery', bg: '#4285F4' },
  gcs: { icon: 'cloud', displayName: 'Cloud Storage', bg: '#4285F4' },
};

/**
 * Renders a small colored badge with a Grafana icon for dependency types.
 */
export function DepTypeIcon({ type, size = 24 }: DepIconProps) {
  const config = ICON_CONFIGS[type];
  if (!config) {
    return (
      <span className={badgeStyle({ bg: '#999', color: '#fff', size })} title={type}>
        <Icon name="question-circle" size="xs" />
      </span>
    );
  }
  const iconSize = size <= 24 ? 'xs' : 'sm';
  return (
    <span className={badgeStyle({ bg: config.bg, color: config.color ?? '#fff', size })} title={config.displayName}>
      <Icon name={config.icon} size={iconSize} />
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
    border-radius: 6px;
    background: ${bg};
    color: ${color};
    line-height: 1;
    flex-shrink: 0;
  `;
}

/** Returns a properly cased display name for a dependency type. */
export function formatDepType(type: string): string {
  return ICON_CONFIGS[type]?.displayName ?? type.charAt(0).toUpperCase() + type.slice(1);
}

export default DepTypeIcon;
