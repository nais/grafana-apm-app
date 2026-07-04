import React, { useMemo } from 'react';
import { useStyles2, LoadingPlaceholder, Alert } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { EmbeddedScene } from '@grafana/scenes';
import { OperationSummary, ConnectedServicesResponse, DependencySummary, HealthSummary } from '../../api/client';
import { formatDuration } from '../../utils/format';
import { CustomMetricsPanel } from '../../components/CustomMetricsPanel';
import { getSectionStyles } from '../../utils/styles';
import { HealthSummarySection } from '../../components/HealthSummary/HealthSummarySection';
import { HealthHeaderRow } from './overview/HealthHeaderRow';
import { SloPanel } from './overview/SloPanel';
import { DependencySignal } from './overview/DependencySignal';

const MAX_OVERVIEW_OPS = 5;

interface OverviewTabProps {
  scene: EmbeddedScene | null;
  namespace: string;
  environment?: string;
  sceneKey: string;
  operations: OperationSummary[];
  opsLoading: boolean;
  opsError: string | null;
  connected?: ConnectedServicesResponse;
  dependencies?: DependencySummary[];
  health?: HealthSummary | null;
  healthLoading?: boolean;
  service: string;
  onViewAllOperations: () => void;
  onViewAllDependencies?: () => void;
  onViewTraces?: (spanName: string, status?: string, spanKindRaw?: string) => void;
  onNavigateDependency?: (name: string, type: string) => void;
}

export function OverviewTab({
  scene,
  namespace,
  environment,
  sceneKey,
  operations,
  opsLoading,
  opsError,
  connected,
  dependencies,
  health,
  healthLoading,
  service,
  onViewAllOperations,
  onViewAllDependencies,
  onViewTraces,
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
      {/* Instant health signal (#35): RED trio as big numbers + delta vs
          previous period, so "is this OK right now?" doesn't require reading
          the timeseries below. */}
      <HealthHeaderRow health={health ?? null} loading={healthLoading ?? false} />

      {/* Error-budget / SLO panel (M7): 30d compliance, remaining budget and
          current burn rate off the RED error ratio, plus multi-window
          burn-rate alert generation — the OSS-niche answer to Cloud-only
          managed SLOs. */}
      <SloPanel namespace={namespace} service={service} environment={environment} />

      {/* RED panels + Duration distribution (includes time picker). Deploy
          markers (#64) are already layered onto every child timeseries panel
          via buildServiceScene's `$data: buildDeployAnnotationsLayer(...)`. */}
      <div style={{ marginBottom: 16 }}>
        {scene ? <scene.Component key={sceneKey} model={scene} /> : <LoadingPlaceholder text="Loading metrics..." />}
      </div>

      {/* Attention section — degraded operations and dependencies */}
      <HealthSummarySection
        health={health ?? null}
        loading={healthLoading ?? false}
        onViewTraces={onViewTraces}
        onNavigateDependency={onNavigateDependency}
      />

      {/* Dependency signal (IA review 2, rule 3) — a count + link to the
          Dependencies tab, not a copy of its graph/tables. */}
      <DependencySignal
        connected={connected}
        dependencies={dependencies}
        health={health}
        onViewDependencies={onViewAllDependencies}
      />

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

      {/* Custom application metrics (#68 Phase 0) — auto-discovered, hidden when
          none. Collapsible and default-collapsed with the discovered-metric
          count in its own header (IA review P9) — the panel manages that
          state itself since it also owns the fetch that produces the count. */}
      <CustomMetricsPanel namespace={namespace} service={service} environment={environment} />
    </>
  );
}

// --- Styles ---

const getStyles = (theme: GrafanaTheme2) => ({
  ...getSectionStyles(theme),
  clickableRow: css`
    cursor: pointer;
    &:hover {
      background: ${theme.colors.background.secondary};
    }
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
