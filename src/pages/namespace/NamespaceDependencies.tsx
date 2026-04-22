import React, { useMemo } from 'react';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { ServiceMapEdge, ServiceMapNode } from '../../api/client';
import { useTableSort, SortHeader, getTableStyles } from '../../components/SortableTable';
import { DepTypeIcon } from '../../components/DepTypeIcon';

export interface ExternalDep {
  name: string;
  nodeType: string;
  callerCount: number;
  rate: number;
  errorRate: number;
  p95: number;
}

interface NamespaceDependenciesProps {
  edges: ServiceMapEdge[];
  nodes: ServiceMapNode[];
  namespaceServices: Set<string>;
}

type SortField = 'name' | 'callerCount' | 'rate' | 'errorRate' | 'p95';

export function NamespaceDependencies({ edges, nodes, namespaceServices }: NamespaceDependenciesProps) {
  const tableStyles = useStyles2(getTableStyles);
  const styles = useStyles2(getLocalStyles);
  const { sortField, sortDir, toggleSort, comparator } = useTableSort<SortField>('rate');

  const deps = useMemo(() => {
    // Build a lookup from node ID to node type
    const nodeTypeMap = new Map<string, string>();
    for (const n of nodes) {
      nodeTypeMap.set(n.id, n.nodeType ?? 'service');
    }

    // Find edges from namespace services to external targets
    const depMap = new Map<string, { callers: Set<string>; rate: number; errors: number; p95: number }>();

    for (const edge of edges) {
      const sourceInNs = namespaceServices.has(edge.source);
      const targetInNs = namespaceServices.has(edge.target);

      // External dep: source is in namespace, target is NOT
      if (sourceInNs && !targetInNs) {
        const existing = depMap.get(edge.target) ?? { callers: new Set(), rate: 0, errors: 0, p95: 0 };
        existing.callers.add(edge.source);
        // Parse rate from mainStat (e.g., "12.3 req/s")
        const rateMatch = edge.mainStat?.match(/^([\d.]+)/);
        if (rateMatch) {
          existing.rate += parseFloat(rateMatch[1]);
        }
        // Parse P95 from secondaryStat (e.g., "P95: 45ms")
        const p95Match = edge.secondaryStat?.match(/([\d.]+)ms/);
        if (p95Match) {
          existing.p95 = Math.max(existing.p95, parseFloat(p95Match[1]));
        }
        depMap.set(edge.target, existing);
      }
    }

    const result: ExternalDep[] = [];
    for (const [name, data] of depMap) {
      result.push({
        name,
        nodeType: nodeTypeMap.get(name) ?? 'external',
        callerCount: data.callers.size,
        rate: data.rate,
        errorRate: 0, // Not easily derivable from edge mainStat; placeholder for Phase 2
        p95: data.p95,
      });
    }
    return result;
  }, [edges, nodes, namespaceServices]);

  const sorted = useMemo(() => [...deps].sort(comparator), [deps, comparator]);

  if (sorted.length === 0) {
    return null;
  }

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>External Dependencies</h3>
      <p className={styles.sectionSubtitle}>
        Services and resources outside this namespace that are called by namespace services.
      </p>
      <table className={tableStyles.table}>
        <colgroup>
          <col style={{ width: '30%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '20%' }} />
        </colgroup>
        <thead>
          <tr>
            <SortHeader field="name" label="Dependency" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <th>Type</th>
            <SortHeader
              field="callerCount"
              label="Callers"
              sortField={sortField}
              sortDir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader field="rate" label="Rate" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader field="p95" label="P95" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((dep) => (
            <tr key={dep.name}>
              <td className={tableStyles.nameCell}>{dep.name}</td>
              <td>
                <DepTypeIcon type={dep.nodeType} />
              </td>
              <td className={tableStyles.numCell}>
                {dep.callerCount} {dep.callerCount === 1 ? 'service' : 'services'}
              </td>
              <td className={tableStyles.numCell}>{dep.rate.toFixed(2)} req/s</td>
              <td className={tableStyles.numCell}>{dep.p95 > 0 ? `${dep.p95.toFixed(0)}ms` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const getLocalStyles = (theme: GrafanaTheme2) => ({
  section: css`
    margin-top: ${theme.spacing(3)};
  `,
  sectionTitle: css`
    margin-bottom: ${theme.spacing(0.5)};
    font-size: ${theme.typography.h4.fontSize};
  `,
  sectionSubtitle: css`
    margin: 0 0 ${theme.spacing(1.5)} 0;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
