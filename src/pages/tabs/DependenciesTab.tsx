import React, { useMemo } from 'react';
import { useStyles2, LoadingPlaceholder, Alert, Badge } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { ConnectedService, DependencySummary } from '../../api/client';
import { DepTypeIcon, formatDepType } from '../../components/DepTypeIcon';
import { formatDuration, formatRate, formatErrorRate } from '../../utils/format';
import { SortHeader, ImpactBar, useTableSort, getTableStyles } from '../../components/SortableTable';
import { groupDependencies, DepGroup } from '../../utils/depGroups';

interface DependenciesTabProps {
  service: string;
  callers?: ConnectedService[];
  callersLoading?: boolean;
  dependencies?: DependencySummary[];
  depsLoading?: boolean;
  depsError?: string | null;
  onNavigateService: (name: string) => void;
  onNavigateDependency?: (name: string) => void;
}

export function DependenciesTab({
  service,
  callers,
  callersLoading,
  dependencies,
  depsLoading,
  depsError,
  onNavigateService,
  onNavigateDependency,
}: DependenciesTabProps) {
  const styles = useStyles2(getStyles);

  const callerList = callers ?? [];
  const depList = useMemo(() => dependencies ?? [], [dependencies]);
  const loading = callersLoading || depsLoading;

  const depGroups = useMemo(() => groupDependencies(depList), [depList]);

  if (loading && callerList.length === 0 && depList.length === 0) {
    return <LoadingPlaceholder text="Loading callers and dependencies..." />;
  }

  if (depsError) {
    return (
      <Alert severity="error" title="Error loading dependencies">
        {depsError}
      </Alert>
    );
  }

  if (callerList.length === 0 && depList.length === 0) {
    return (
      <Alert severity="info" title="No callers or dependencies detected">
        No callers or dependencies found for {service}. Callers are detected from inbound service graph edges.
        Dependencies are detected from outbound client spans (HTTP calls, database queries, etc.) in span metrics.
      </Alert>
    );
  }

  return (
    <div className={styles.container}>
      {/* Callers section */}
      {callerList.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Callers ({callerList.length})</h3>
          <p className={styles.sectionSubtitle}>Services that call {service}.</p>
          <CallersTable callers={callerList} onNavigate={onNavigateService} />
        </div>
      )}

      {/* Dependencies — grouped by type */}
      {depGroups.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Dependencies ({depList.length})</h3>
          <p className={styles.sectionSubtitle}>Databases, APIs, and services that {service} calls.</p>
          {depGroups.map((group) => (
            <DepGroupTable key={group.key} group={group} onNavigate={onNavigateDependency} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Callers sortable table ---

type CallerSortField = 'name' | 'rate' | 'errorRate' | 'p95Duration';

function CallersTable({ callers, onNavigate }: { callers: ConnectedService[]; onNavigate: (name: string) => void }) {
  const styles = useStyles2(getStyles);
  const { sortField, sortDir, toggleSort, comparator } = useTableSort<CallerSortField>('rate', 'desc', 'caller');

  const sorted = useMemo(() => [...callers].sort(comparator), [callers, comparator]);

  return (
    <table className={styles.table}>
      <colgroup>
        <col style={{ width: '35%' }} />
        <col style={{ width: '12%' }} />
        <col style={{ width: '18%' }} />
        <col style={{ width: '15%' }} />
        <col style={{ width: '20%' }} />
      </colgroup>
      <thead>
        <tr>
          <SortHeader field="name" label="Service" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          <th>Type</th>
          <SortHeader field="rate" label="Throughput" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          <SortHeader field="errorRate" label="Error %" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          <SortHeader
            field="p95Duration"
            label="Latency (P95)"
            sortField={sortField}
            sortDir={sortDir}
            onSort={toggleSort}
          />
        </tr>
      </thead>
      <tbody>
        {sorted.map((s) => {
          const isNavigable = !s.connectionType;
          return (
            <tr
              key={s.name + (s.connectionType ?? '')}
              className={isNavigable ? styles.clickableRow : undefined}
              style={s.isSidecar ? { opacity: 0.6 } : undefined}
              onClick={isNavigable ? () => onNavigate(s.name) : undefined}
            >
              <td className={isNavigable ? styles.nameCell : undefined} title={s.name}>
                {s.name}
                {s.isSidecar && <Badge text="sidecar" color="orange" icon="cog" className={styles.sidecarBadge} />}
              </td>
              <td className={styles.kindCell}>
                <ConnectionTypeBadge type={s.connectionType} />
              </td>
              <td className={styles.numCell}>{formatRate(s.rate)}</td>
              <td className={s.errorRate > 0 ? styles.errorCell : styles.numCell}>{formatErrorRate(s.errorRate)}</td>
              <td className={styles.numCell}>{formatDuration(s.p95Duration, s.durationUnit)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// --- Grouped dependencies table ---

function DepGroupTable({ group, onNavigate }: { group: DepGroup; onNavigate?: (name: string) => void }) {
  const styles = useStyles2(getStyles);
  const { sortField, sortDir, toggleSort, comparator } = useTableSort<keyof DependencySummary>(
    'rate',
    'desc',
    `dep-${group.key}`
  );

  const sorted = useMemo(() => [...group.items].sort(comparator), [group.items, comparator]);

  return (
    <div className={styles.depGroupSection}>
      <div className={styles.depGroupHeader}>
        <span className={styles.depGroupLabel}>{group.label}</span>
        <span className={styles.depGroupCount}>{group.items.length}</span>
      </div>
      <table className={styles.table}>
        <colgroup>
          <col style={{ width: '35%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '13%' }} />
        </colgroup>
        <thead>
          <tr>
            <SortHeader field="name" label="Dependency" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader field="type" label="Type" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader field="rate" label="Throughput" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader field="errorRate" label="Error %" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader
              field="p95Duration"
              label="Latency (P95)"
              sortField={sortField}
              sortDir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader field="impact" label="Impact" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((dep) => (
            <tr
              key={dep.name}
              className={onNavigate ? styles.clickableRow : undefined}
              onClick={onNavigate ? () => onNavigate(dep.name) : undefined}
            >
              <td className={styles.nameCell} title={dep.name}>
                <DepTypeIcon type={dep.type} />
                <span style={{ marginLeft: 8 }}>{dep.displayName || dep.name}</span>
              </td>
              <td className={styles.kindCell}>{formatDepType(dep.type)}</td>
              <td className={styles.numCell}>{formatRate(dep.rate)}</td>
              <td className={dep.errorRate > 0 ? styles.errorCell : styles.numCell}>
                {formatErrorRate(dep.errorRate)}
              </td>
              <td className={styles.numCell}>{formatDuration(dep.p95Duration, dep.durationUnit)}</td>
              <td className={styles.numCell}>
                <ImpactBar impact={dep.impact} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Connection type badge ---

const CONNECTION_TYPE_LABELS: Record<string, { text: string; color: 'blue' | 'green' | 'orange' | 'purple' }> = {
  database: { text: 'Database', color: 'purple' },
  messaging_system: { text: 'Messaging', color: 'orange' },
  virtual_node: { text: 'External', color: 'blue' },
};

function ConnectionTypeBadge({ type }: { type?: string }) {
  if (!type) {
    return null;
  }
  const info = CONNECTION_TYPE_LABELS[type];
  return info ? <Badge text={info.text} color={info.color} /> : null;
}

// --- Styles ---

const getStyles = (theme: GrafanaTheme2) => ({
  ...getTableStyles(theme),
  container: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(3)};
  `,
  section: css`
    & + & {
      padding-top: ${theme.spacing(1)};
    }
  `,
  sectionTitle: css`
    font-size: ${theme.typography.h4.fontSize};
    margin: 0 0 ${theme.spacing(0.5)} 0;
  `,
  sectionSubtitle: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin: 0 0 ${theme.spacing(1)} 0;
  `,
  kindCell: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  sidecarBadge: css`
    margin-left: ${theme.spacing(1)};
  `,
  depGroupSection: css`
    margin-bottom: ${theme.spacing(2.5)};
    &:last-child {
      margin-bottom: 0;
    }
  `,
  depGroupHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(0.5)};
    padding-top: ${theme.spacing(1)};
    border-top: 1px solid ${theme.colors.border.weak};
    &:first-child {
      border-top: none;
      padding-top: 0;
    }
  `,
  depGroupLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `,
  depGroupCount: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.disabled};
  `,
});
