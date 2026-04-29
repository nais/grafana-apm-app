import { DependencySummary } from '../api/client';

export const INFRA_TYPES = new Set([
  'postgresql',
  'oracle',
  'redis',
  'mongodb',
  'mysql',
  'db2',
  'opensearch',
  'h2',
  'database',
  'kafka',
  'rabbitmq',
  'messaging',
]);

export interface DepGroup {
  key: string;
  label: string;
  items: DependencySummary[];
}

/**
 * Groups dependencies into categorized sections:
 * - Attention: deps with errors (sorted by error rate)
 * - Databases & Messaging: infrastructure deps
 * - Internal Services: K8s internal services
 * - External Services: external APIs/hostnames
 */
export function groupDependencies(deps: DependencySummary[]): DepGroup[] {
  const attention: DependencySummary[] = [];
  const infra: DependencySummary[] = [];
  const internal: DependencySummary[] = [];
  const external: DependencySummary[] = [];

  for (const dep of deps) {
    if (INFRA_TYPES.has(dep.type)) {
      infra.push(dep);
    } else if (dep.type === 'service') {
      internal.push(dep);
    } else {
      external.push(dep);
    }
    if (dep.errorRate > 0) {
      attention.push(dep);
    }
  }

  const byRate = (a: DependencySummary, b: DependencySummary) => b.rate - a.rate;
  const byError = (a: DependencySummary, b: DependencySummary) => b.errorRate - a.errorRate;
  attention.sort(byError);
  infra.sort(byRate);
  internal.sort(byRate);
  external.sort(byRate);

  const groups: DepGroup[] = [];
  if (attention.length > 0) {
    groups.push({ key: 'attention', label: 'Attention', items: attention });
  }
  if (infra.length > 0) {
    groups.push({ key: 'infra', label: 'Databases & Messaging', items: infra });
  }
  if (internal.length > 0) {
    groups.push({ key: 'internal', label: 'Internal Services', items: internal });
  }
  if (external.length > 0) {
    groups.push({ key: 'external', label: 'External Services', items: external });
  }
  return groups;
}
