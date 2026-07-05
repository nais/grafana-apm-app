import React from 'react';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { ConnectedServicesResponse, DependencySummary, HealthSummary } from '../../../api/client';

interface DependencySignalProps {
  connected?: ConnectedServicesResponse;
  dependencies?: DependencySummary[];
  health?: HealthSummary | null;
  onViewDependencies?: () => void;
}

/**
 * Overview's dependency signal (IA review 2, rule 3): a one-line summary +
 * link, not a copy of the Dependencies tab's graph/tables. "Unhealthy" reuses
 * `health.degradedDeps` — the same anomaly-detected list the "Attention
 * needed" section above already renders — so the count here never disagrees
 * with what a click into that section shows.
 */
export function DependencySignal({ connected, dependencies, health, onViewDependencies }: DependencySignalProps) {
  const styles = useStyles2(getStyles);

  const depCount = dependencies?.length ?? 0;
  const callerCount = connected?.inbound.length ?? 0;
  const unhealthyCount = health?.degradedDeps?.length ?? 0;

  // Content-gate (rule 6): nothing to summarize, nothing to show.
  if (depCount === 0 && callerCount === 0) {
    return null;
  }

  const parts: string[] = [`${depCount} ${depCount === 1 ? 'dependency' : 'dependencies'}`];
  if (unhealthyCount > 0) {
    parts.push(`${unhealthyCount} unhealthy`);
  }
  if (callerCount > 0) {
    parts.push(`${callerCount} ${callerCount === 1 ? 'caller' : 'callers'}`);
  }

  const label = `${parts.join(' · ')} →`;
  const clickable = !!onViewDependencies;

  return (
    <button
      type="button"
      className={unhealthyCount > 0 ? styles.signalWarn : styles.signal}
      onClick={onViewDependencies}
      disabled={!clickable}
      title="View Dependencies tab"
    >
      {label}
    </button>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  signal: css`
    display: inline-flex;
    align-items: center;
    margin: 0 0 ${theme.spacing(2)} 0;
    padding: ${theme.spacing(0.75)} ${theme.spacing(1.5)};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    cursor: pointer;
    &:hover {
      background: ${theme.colors.action.hover};
    }
    &:disabled {
      cursor: default;
    }
  `,
  signalWarn: css`
    display: inline-flex;
    align-items: center;
    margin: 0 0 ${theme.spacing(2)} 0;
    padding: ${theme.spacing(0.75)} ${theme.spacing(1.5)};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.warning.border};
    border-radius: ${theme.shape.radius.default};
    color: ${theme.colors.warning.text};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    cursor: pointer;
    &:hover {
      background: ${theme.colors.action.hover};
    }
    &:disabled {
      cursor: default;
    }
  `,
});
