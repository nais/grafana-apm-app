import React, { useMemo, useState } from 'react';
import { Badge, Icon, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { AlertRuleSummary } from '../../api/client';
import { getSectionStyles } from '../../utils/styles';

interface NamespaceAlertsProps {
  rules: AlertRuleSummary[];
  unavailable?: boolean;
}

const STATE_CONFIG: Record<string, { color: 'red' | 'orange' | 'blue'; icon: string; order: number }> = {
  firing: { color: 'red', icon: 'fire', order: 0 },
  pending: { color: 'orange', icon: 'clock-nine', order: 1 },
  inactive: { color: 'blue', icon: 'check-circle', order: 2 },
};

export function NamespaceAlerts({ rules, unavailable }: NamespaceAlertsProps) {
  const styles = useStyles2(getStyles);
  const [showInactive, setShowInactive] = useState(false);

  const { active, inactive, firingCount } = useMemo(() => {
    const act: AlertRuleSummary[] = [];
    const inact: AlertRuleSummary[] = [];
    let firing = 0;
    for (const rule of rules) {
      if (rule.state === 'inactive') {
        inact.push(rule);
      } else {
        act.push(rule);
        if (rule.state === 'firing') {
          firing++;
        }
      }
    }
    return { active: act, inactive: inact, firingCount: firing };
  }, [rules]);

  if (unavailable || rules.length === 0) {
    return null;
  }

  const stateLabel =
    firingCount > 0
      ? `${firingCount} firing`
      : active.length > 0
        ? `${active.length} pending`
        : `${rules.length} configured`;

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>
        <Icon name="bell" className={styles.titleIcon} />
        Alert Rules ({stateLabel})
      </h3>

      {active.length > 0 && (
        <div className={styles.rulesList}>
          {active.map((rule) => (
            <AlertRuleCard key={`${rule.groupName}/${rule.name}`} rule={rule} />
          ))}
        </div>
      )}

      {inactive.length > 0 && (
        <>
          <button className={styles.toggleButton} onClick={() => setShowInactive(!showInactive)}>
            <Icon name={showInactive ? 'angle-down' : 'angle-right'} />
            {inactive.length} inactive rule{inactive.length !== 1 ? 's' : ''}
          </button>
          {showInactive && (
            <div className={styles.rulesList}>
              {inactive.map((rule) => (
                <AlertRuleCard key={`${rule.groupName}/${rule.name}`} rule={rule} />
              ))}
            </div>
          )}
        </>
      )}

      {active.length === 0 && !showInactive && (
        <p className={styles.allGood}>All alert rules are inactive — no issues detected.</p>
      )}
    </div>
  );
}

function AlertRuleCard({ rule }: { rule: AlertRuleSummary }) {
  const styles = useStyles2(getStyles);
  const config = STATE_CONFIG[rule.state] ?? STATE_CONFIG.inactive;

  return (
    <div className={styles.ruleCard} data-state={rule.state}>
      <div className={styles.ruleHeader}>
        <Badge text={rule.state} color={config.color} icon={config.icon as any} />
        <span className={styles.ruleName}>{rule.name}</span>
        {rule.severity && <Badge text={rule.severity} color={rule.severity === 'critical' ? 'red' : 'orange'} />}
      </div>
      <div className={styles.ruleMeta}>
        {(rule.summary || rule.description) && (
          <span className={styles.ruleSummary}>{rule.summary || rule.description}</span>
        )}
        {rule.activeCount > 0 && (
          <span className={styles.activeCount}>
            {rule.activeCount} instance{rule.activeCount !== 1 ? 's' : ''}
          </span>
        )}
        {rule.activeSince && (
          <span className={styles.activeSince}>· Active since {formatRelativeTime(rule.activeSince)}</span>
        )}
      </div>
    </div>
  );
}

function formatRelativeTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    const now = Date.now();
    const diffMs = now - date.getTime();
    if (diffMs < 60_000) {
      return 'just now';
    }
    if (diffMs < 3_600_000) {
      return `${Math.floor(diffMs / 60_000)}m ago`;
    }
    if (diffMs < 86_400_000) {
      return `${Math.floor(diffMs / 3_600_000)}h ago`;
    }
    return `${Math.floor(diffMs / 86_400_000)}d ago`;
  } catch {
    return isoString;
  }
}

const getStyles = (theme: GrafanaTheme2) => ({
  ...getSectionStyles(theme),
  titleIcon: css`
    margin-right: ${theme.spacing(0.75)};
  `,
  rulesList: css`
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: ${theme.spacing(1)};
    @media (max-width: 900px) {
      grid-template-columns: 1fr;
    }
  `,
  ruleCard: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
    border-radius: ${theme.shape.radius.default};
    &[data-state='firing'] {
      border-left: 3px solid ${theme.colors.error.main};
      background: ${theme.colors.error.transparent};
    }
    &[data-state='pending'] {
      border-left: 3px solid ${theme.colors.warning.main};
      background: ${theme.colors.warning.transparent};
    }
    &[data-state='inactive'] {
      border-left: 3px solid ${theme.colors.border.weak};
    }
  `,
  ruleHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
  `,
  ruleName: css`
    font-weight: ${theme.typography.fontWeightMedium};
    font-size: ${theme.typography.body.fontSize};
  `,
  activeCount: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  ruleMeta: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    flex-wrap: wrap;
  `,
  ruleSummary: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  activeSince: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.disabled};
  `,
  toggleButton: css`
    background: none;
    border: none;
    color: ${theme.colors.text.secondary};
    cursor: pointer;
    font-size: ${theme.typography.bodySmall.fontSize};
    padding: ${theme.spacing(0.5)} 0;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
  allGood: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin: 0;
  `,
});
