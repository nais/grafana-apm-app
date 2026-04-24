import React, { useMemo } from 'react';
import { useStyles2, Icon, LoadingPlaceholder, Alert, Badge } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { EmbeddedScene } from '@grafana/scenes';
import { OperationSummary, ConnectedServicesResponse, DependencySummary } from '../../api/client';
import { formatDuration, formatRate, formatErrorRate } from '../../utils/format';
import { DepTypeIcon, formatDepType } from '../../components/DepTypeIcon';
import { getSectionStyles } from '../../utils/styles';
import { ServiceGraph, ServiceGraphNode, ServiceGraphEdge } from '../../components/ServiceGraph';

const MAX_OVERVIEW_OPS = 5;

interface OverviewTabProps {
  scene: EmbeddedScene | null;
  sceneKey: string;
  operations: OperationSummary[];
  opsLoading: boolean;
  opsError: string | null;
  graphNodes: ServiceGraphNode[];
  graphEdges: ServiceGraphEdge[];
  connected?: ConnectedServicesResponse;
  dependencies?: DependencySummary[];
  service: string;
  onViewAllOperations: () => void;
  onViewTraces?: (spanName: string, status?: string, spanKindRaw?: string) => void;
  onNavigateService: (name: string) => void;
  onNavigateDependency?: (name: string) => void;
}

export function OverviewTab({
  scene,
  sceneKey,
  operations,
  opsLoading,
  opsError,
  graphNodes,
  graphEdges,
  connected,
  dependencies,
  service,
  onViewAllOperations,
  onViewTraces,
  onNavigateService,
  onNavigateDependency,
}: OverviewTabProps) {
  const styles = useStyles2(getStyles);

  const overviewOps = useMemo(() => {
    const byRate = [...operations].sort((a, b) => b.rate - a.rate);
    const topN = byRate.slice(0, MAX_OVERVIEW_OPS);
    const topKeys = new Set(topN.map((o) => `${o.spanName}|${o.spanKind}`));
    const erroring = operations
      .filter((o) => o.errorRate > 0 && !topKeys.has(`${o.spanName}|${o.spanKind}`))
      .sort((a, b) => b.errorRate - a.errorRate)
      .slice(0, MAX_OVERVIEW_OPS);
    return [...topN, ...erroring];
  }, [operations]);

  const hiddenCount = operations.length - overviewOps.length;

  return (
    <>
      {/* RED panels + Duration distribution */}
      <div style={{ marginBottom: 16 }}>
        {scene ? <scene.Component key={sceneKey} model={scene} /> : <LoadingPlaceholder text="Loading metrics..." />}
      </div>

      {/* Operations table */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Operations</h3>
        <p className={styles.sectionSubtitle}>Top operations across all span kinds, sorted by throughput.</p>
        {opsError && (
          <Alert severity="error" title="Error">
            {opsError}
          </Alert>
        )}
        {opsLoading && <LoadingPlaceholder text="Loading operations..." />}
        {!opsLoading && operations.length === 0 && (
          <Alert severity="info" title="No operations found">
            No span operations found for this service.
          </Alert>
        )}
        {!opsLoading && operations.length > 0 && (
          <>
            <table className={styles.opsTable}>
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Kind</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}>Error %</th>
                  <th style={{ textAlign: 'right' }}>P50</th>
                  <th style={{ textAlign: 'right' }}>P95</th>
                  <th style={{ textAlign: 'right' }}>P99</th>
                </tr>
              </thead>
              <tbody>
                {overviewOps.map((op) => {
                  const clickable = !!onViewTraces;
                  return (
                    <tr
                      key={`${op.spanName}-${op.spanKind}`}
                      className={clickable ? styles.clickableRow : undefined}
                      onClick={
                        clickable
                          ? () =>
                              onViewTraces(
                                op.spanName,
                                op.errorRate > 0 ? 'error' : undefined,
                                op.spanKindRaw || undefined
                              )
                          : undefined
                      }
                      title={clickable ? `View traces for ${op.spanName} (${op.spanKind})` : undefined}
                    >
                      <td className={styles.opNameCell}>{op.spanName}</td>
                      <td className={styles.opKindCell}>{op.spanKind}</td>
                      <td className={styles.opNumCell}>{op.rate.toFixed(2)} req/s</td>
                      <td className={op.errorRate > 0 ? styles.opErrorCell : styles.opNumCell}>
                        {op.errorRate.toFixed(1)}%
                      </td>
                      <td className={styles.opNumCell}>{formatDuration(op.p50Duration, op.durationUnit)}</td>
                      <td className={styles.opNumCell}>{formatDuration(op.p95Duration, op.durationUnit)}</td>
                      <td className={styles.opNumCell}>{formatDuration(op.p99Duration, op.durationUnit)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <button className={styles.viewAllLink} onClick={onViewAllOperations}>
              {hiddenCount > 0 ? `View all ${operations.length} operations →` : 'View all operations →'}
            </button>
          </>
        )}
      </div>

      {/* Service topology graph */}
      {graphNodes.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Service Topology</h3>
          <div className={styles.graphPanel}>
            <div style={{ height: 350 }}>
              <ServiceGraph nodes={graphNodes} edges={graphEdges} focusNode={service} direction="RIGHT" />
            </div>
          </div>
        </div>
      )}

      {/* Connected services & Dependencies — side by side */}
      {((connected && (connected.inbound.length > 0 || connected.outbound.length > 0)) ||
        (dependencies && dependencies.length > 0)) && (
        <div className={styles.section}>
          <div className={styles.connectedGrid}>
            {/* Connected Services column */}
            {connected && (connected.inbound.length > 0 || connected.outbound.length > 0) && (
              <div>
                <h3 className={styles.sectionTitle}>Connected Services</h3>
                {connected.inbound.length > 0 && (
                  <ConnectedTable
                    title="Inbound"
                    icon="arrow-down"
                    services={connected.inbound}
                    onNavigate={onNavigateService}
                  />
                )}
                {connected.outbound.length > 0 && (
                  <ConnectedTable
                    title="Outbound"
                    icon="arrow-up"
                    services={connected.outbound}
                    onNavigate={onNavigateService}
                  />
                )}
              </div>
            )}

            {/* Dependencies column */}
            {dependencies && dependencies.length > 0 && (
              <div>
                <h3 className={styles.sectionTitle}>Dependencies ({dependencies.length})</h3>
                <DependenciesCompact dependencies={dependencies} onNavigate={onNavigateDependency} />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// --- Internal helpers ---

const CONNECTION_TYPE_LABELS: Record<
  string,
  { text: string; color: 'blue' | 'green' | 'orange' | 'red' | 'purple'; icon?: string }
> = {
  database: { text: 'Database', color: 'purple', icon: 'database' },
  messaging_system: { text: 'Messaging', color: 'orange', icon: 'envelope' },
  virtual_node: { text: 'External', color: 'blue', icon: 'cloud' },
};

function ConnectionTypeBadge({ type }: { type?: string }) {
  if (!type) {
    return null;
  }
  const info = CONNECTION_TYPE_LABELS[type];
  if (!info) {
    return null;
  }
  return <Badge text={info.text} color={info.color} icon={info.icon as any} />;
}

interface ConnectedTableProps {
  title: string;
  icon: 'arrow-down' | 'arrow-up';
  services: ConnectedServicesResponse['inbound'];
  onNavigate: (name: string) => void;
}

function ConnectedTable({ title, icon, services, onNavigate }: ConnectedTableProps) {
  const styles = useStyles2(getStyles);
  return (
    <div>
      <h4 className={styles.connectedSubtitle}>
        <Icon name={icon} /> {title} ({services.length})
      </h4>
      <table className={styles.opsTable}>
        <thead>
          <tr>
            <th>Service</th>
            <th>Type</th>
            <th>Rate</th>
            <th>Error %</th>
            <th>P95</th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => (
            <tr
              key={s.name + (s.connectionType ?? '')}
              className={s.connectionType ? undefined : styles.clickableRow}
              style={s.isSidecar ? { opacity: 0.6 } : undefined}
              onClick={
                s.connectionType
                  ? undefined
                  : () => {
                      onNavigate(s.name);
                    }
              }
            >
              <td className={s.connectionType ? undefined : styles.linkCell}>
                {s.name}
                {s.isSidecar && <Badge text="sidecar" color="orange" icon="cog" className={styles.sidecarBadge} />}
              </td>
              <td>
                <ConnectionTypeBadge type={s.connectionType} />
              </td>
              <td className={styles.opNumCell}>{s.rate.toFixed(2)} req/s</td>
              <td className={s.errorRate > 0 ? styles.opErrorCell : styles.opNumCell}>{s.errorRate.toFixed(1)}%</td>
              <td className={styles.opNumCell}>{formatDuration(s.p95Duration, s.durationUnit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Dependencies compact list for overview ---

interface DependenciesCompactProps {
  dependencies: DependencySummary[];
  onNavigate?: (name: string) => void;
}

function DependenciesCompact({ dependencies, onNavigate }: DependenciesCompactProps) {
  const styles = useStyles2(getStyles);
  const sorted = useMemo(() => [...dependencies].sort((a, b) => b.rate - a.rate), [dependencies]);

  return (
    <table className={styles.opsTable}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Rate</th>
          <th>Error %</th>
          <th>P95</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((dep) => (
          <tr
            key={dep.name}
            className={onNavigate ? styles.clickableRow : undefined}
            onClick={onNavigate ? () => onNavigate(dep.name) : undefined}
          >
            <td className={styles.linkCell} title={dep.name}>
              <DepTypeIcon type={dep.type} />
              <span style={{ marginLeft: 6 }}>{dep.displayName || dep.name}</span>
            </td>
            <td className={styles.opKindCell}>{formatDepType(dep.type)}</td>
            <td className={styles.opNumCell}>{formatRate(dep.rate)}</td>
            <td className={dep.errorRate > 0 ? styles.opErrorCell : styles.opNumCell}>
              {formatErrorRate(dep.errorRate)}
            </td>
            <td className={styles.opNumCell}>{formatDuration(dep.p95Duration, dep.durationUnit)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- Styles ---

const getStyles = (theme: GrafanaTheme2) => ({
  ...getSectionStyles(theme),
  graphPanel: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)};
    overflow: hidden;
  `,
  connectedGrid: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: ${theme.spacing(3)};
    @media (max-width: 768px) {
      grid-template-columns: 1fr;
    }
  `,
  connectedSubtitle: css`
    font-size: ${theme.typography.body.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    margin-bottom: ${theme.spacing(1)};
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  clickableRow: css`
    cursor: pointer;
    &:hover {
      background: ${theme.colors.background.secondary};
    }
  `,
  linkCell: css`
    font-weight: ${theme.typography.fontWeightMedium};
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${theme.colors.text.link};
  `,
  sidecarBadge: css`
    margin-left: ${theme.spacing(0.75)};
    vertical-align: middle;
  `,
  viewAllLink: css`
    display: block;
    margin-top: ${theme.spacing(1.5)};
    padding: 0;
    background: none;
    border: none;
    color: ${theme.colors.text.link};
    font-size: ${theme.typography.bodySmall.fontSize};
    cursor: pointer;
    &:hover {
      text-decoration: underline;
    }
  `,
  opsTable: css`
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    table-layout: fixed;
    th:nth-child(1) {
      width: 30%;
    }
    th:nth-child(2) {
      width: 10%;
    }
    th {
      text-align: left;
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      color: ${theme.colors.text.secondary};
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      border-bottom: 1px solid ${theme.colors.border.medium};
      white-space: nowrap;
    }
    th:nth-child(n + 3) {
      width: 12%;
      text-align: right;
    }
    td {
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: middle;
    }
    tr:hover {
      background: ${theme.colors.background.secondary};
    }
  `,
  opNameCell: css`
    font-weight: ${theme.typography.fontWeightMedium};
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  opKindCell: css`
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
  `,
  opNumCell: css`
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  `,
  opErrorCell: css`
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
});
