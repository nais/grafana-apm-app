/** Format a duration value with appropriate units */
export function formatDuration(value: number, unit: string): string {
  if (unit === 'ms') {
    if (value < 1) {
      return '< 1ms';
    }
    if (value >= 1000) {
      return `${(value / 1000).toFixed(1)}s`;
    }
    return `${Math.round(value)}ms`;
  }
  if (value < 0.001) {
    return '< 1ms';
  }
  if (value < 1) {
    return `${Math.round(value * 1000)}ms`;
  }
  return `${value.toFixed(1)}s`;
}

/** Dependency type → emoji icon mapping */
export const DEP_TYPE_ICONS: Record<string, string> = {
  redis: '🔴',
  postgresql: '🐘',
  mysql: '🐬',
  mongodb: '🍃',
  kafka: '📨',
  rabbitmq: '🐇',
  elasticsearch: '🔍',
  memcached: '⚡',
  external: '🌐',
  service: '🔷',
};
