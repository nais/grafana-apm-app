import React from 'react';
import { useStyles2, Icon } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { HealthSummary as HealthData, DegradedOperation, DegradedDependency } from '../../api/client';
import { formatDuration } from '../../utils/format';

interface HealthSummaryProps {
  health: HealthData | null;
  loading: boolean;
  onViewTraces?: (spanName: string, status?: string, spanKindRaw?: string) => void;
  onNavigateDependency?: (name: string, type: string) => void;
}

/**
 * Renders an attention alert when degraded operations or dependencies are detected.
 * Includes causality analysis: tells the developer whether errors are likely
 * caused by downstream dependencies or appear internal to the service.
 * Only visible when there's something actionable — no noise when everything is healthy.
 */
export function HealthSummarySection({ health, loading, onViewTraces, onNavigateDependency }: HealthSummaryProps) {
  const styles = useStyles2(getStyles);

  if (!health || loading) {
    return null;
  }

  const degradedOps = health.degradedOps ?? [];
  const degradedDeps = health.degradedDeps ?? [];
  const hasAttention = degradedOps.length > 0 || degradedDeps.length > 0;

  if (!hasAttention) {
    return null;
  }

  const cause = health.causeCategory ?? '';
  const isDownstreamLikely = cause === 'downstream-likely';
  const subtitle = causeSubtitle(cause);

  return (
    <div className={styles.attentionSection}>
      <div className={styles.attentionHeader}>
        <Icon name="exclamation-triangle" size="sm" />
        <span>Attention needed</span>
      </div>
      {subtitle && <div className={styles.attentionSubtitle}>{subtitle}</div>}

      {/* When downstream-likely, show root cause (deps) first */}
      {isDownstreamLikely ? (
        <>
          {degradedDeps.length > 0 && (
            <DegradedDepsGroup
              deps={degradedDeps}
              label="Degraded dependencies (likely root cause)"
              onNavigate={onNavigateDependency}
            />
          )}
          {degradedOps.length > 0 && (
            <DegradedOpsGroup ops={degradedOps} label="Affected operations" onViewTraces={onViewTraces} />
          )}
        </>
      ) : (
        <>
          {degradedOps.length > 0 && (
            <DegradedOpsGroup ops={degradedOps} label="Degraded operations" onViewTraces={onViewTraces} />
          )}
          {degradedDeps.length > 0 && (
            <DegradedDepsGroup deps={degradedDeps} label="Degraded dependencies" onNavigate={onNavigateDependency} />
          )}
        </>
      )}

      {cause === 'downstream-only' && (
        <div className={styles.attentionNote}>This service&apos;s own operations appear unaffected.</div>
      )}
    </div>
  );
}

// --- Cause subtitle mapping ---

function causeSubtitle(cause: string): string {
  switch (cause) {
    case 'downstream-likely':
      return 'Errors likely cascading from degraded dependencies';
    case 'mixed':
      return 'Both internal errors and downstream issues detected';
    case 'no-downstream-detected':
      return 'No downstream dependency issues detected — errors may be internal';
    case 'downstream-only':
      return 'Downstream dependencies degraded';
    default:
      return '';
  }
}

// --- Degraded ops group ---

interface DegradedOpsGroupProps {
  ops: DegradedOperation[];
  label: string;
  onViewTraces?: (spanName: string, status?: string, spanKindRaw?: string) => void;
}

function DegradedOpsGroup({ ops, label, onViewTraces }: DegradedOpsGroupProps) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.attentionGroup}>
      <span className={styles.attentionLabel}>{label}</span>
      {ops.map((op) => (
        <DegradedOpRow key={`${op.spanName}-${op.spanKind}`} op={op} onViewTraces={onViewTraces} />
      ))}
    </div>
  );
}

// --- Degraded deps group ---

interface DegradedDepsGroupProps {
  deps: DegradedDependency[];
  label: string;
  onNavigate?: (name: string, type: string) => void;
}

function DegradedDepsGroup({ deps, label, onNavigate }: DegradedDepsGroupProps) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.attentionGroup}>
      <span className={styles.attentionLabel}>{label}</span>
      {deps.map((dep) => (
        <DegradedDepRow key={dep.name} dep={dep} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

// --- Degraded operation row ---

interface DegradedOpRowProps {
  op: DegradedOperation;
  onViewTraces?: (spanName: string, status?: string, spanKindRaw?: string) => void;
}

function DegradedOpRow({ op, onViewTraces }: DegradedOpRowProps) {
  const styles = useStyles2(getStyles);

  const reasons: string[] = [];
  if (op.errorAnomaly) {
    reasons.push(`error rate ${op.errorRate.toFixed(1)}% (was ${op.prevErrorRate.toFixed(1)}%)`);
  }
  if (op.latencyAnomaly) {
    reasons.push(
      `P95 ${formatDuration(op.p95Duration, op.durationUnit)} (was ${formatDuration(op.prevP95Duration, op.durationUnit)})`
    );
  }

  return (
    <div
      className={onViewTraces ? styles.attentionRowClickable : styles.attentionRow}
      onClick={onViewTraces ? () => onViewTraces(op.spanName, op.errorAnomaly ? 'error' : undefined) : undefined}
      title={onViewTraces ? `View traces for ${op.spanName}` : undefined}
    >
      <span className={styles.attentionName}>
        <Icon name="gf-grid" size="sm" />
        {op.spanName}
        <span className={styles.attentionKind}>({op.spanKind})</span>
      </span>
      <span className={styles.attentionReason}>{reasons.join(' · ')}</span>
    </div>
  );
}

// --- Degraded dependency row ---

interface DegradedDepRowProps {
  dep: DegradedDependency;
  onNavigate?: (name: string, type: string) => void;
}

function DegradedDepRow({ dep, onNavigate }: DegradedDepRowProps) {
  const styles = useStyles2(getStyles);

  const reasons: string[] = [];
  if (dep.errorAnomaly) {
    reasons.push(`error rate ${dep.errorRate.toFixed(1)}% (was ${dep.prevErrorRate.toFixed(1)}%)`);
  }
  if (dep.latencyAnomaly) {
    reasons.push(
      `P95 ${formatDuration(dep.p95Duration, dep.durationUnit)} (was ${formatDuration(dep.prevP95Duration, dep.durationUnit)})`
    );
  }

  return (
    <div
      className={onNavigate ? styles.attentionRowClickable : styles.attentionRow}
      onClick={onNavigate ? () => onNavigate(dep.name, dep.type) : undefined}
      title={onNavigate ? `View dependency: ${dep.name}` : undefined}
    >
      <span className={styles.attentionName}>
        <Icon name="arrow-right" size="sm" />
        {dep.name}
      </span>
      <span className={styles.attentionReason}>{reasons.join(' · ')}</span>
    </div>
  );
}

// --- Styles ---

const getStyles = (theme: GrafanaTheme2) => ({
  attentionSection: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.warning.border};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
    margin-bottom: ${theme.spacing(2)};
  `,
  attentionHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.warning.text};
    margin-bottom: ${theme.spacing(0.5)};
  `,
  attentionSubtitle: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin-bottom: ${theme.spacing(1.5)};
  `,
  attentionGroup: css`
    &:not(:last-child) {
      margin-bottom: ${theme.spacing(1.5)};
      padding-bottom: ${theme.spacing(1.5)};
      border-bottom: 1px solid ${theme.colors.border.weak};
    }
  `,
  attentionLabel: css`
    display: block;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: ${theme.spacing(0.5)};
  `,
  attentionRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${theme.spacing(2)};
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    border-radius: ${theme.shape.radius.default};
  `,
  attentionRowClickable: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${theme.spacing(2)};
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    border-radius: ${theme.shape.radius.default};
    cursor: pointer;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  attentionName: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  attentionKind: css`
    font-weight: ${theme.typography.fontWeightRegular};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  attentionReason: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.error.text};
    white-space: nowrap;
    flex-shrink: 0;
  `,
  attentionNote: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-style: italic;
    margin-top: ${theme.spacing(1)};
  `,
});
