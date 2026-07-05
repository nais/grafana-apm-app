import React from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, Toggletip, useStyles2 } from '@grafana/ui';
import { getScorecard, ScorecardConsole, ScorecardResponse } from '../api/scorecard';
import { useFetch } from '../utils/useFetch';

interface ScorecardBadgeProps {
  namespace: string;
  service: string;
  environment?: string;
}

/**
 * Compact observability-readiness badge for the service header (M7 service
 * scorecards): "4/6 observability checks" colored by fraction. Clicking opens
 * a toggletip listing each check with an enablement hint, plus ownership
 * links from the nais Console when configured.
 *
 * Renders nothing while the fetch is in flight or on error — the header must
 * not shift or show placeholders for an optional enrichment.
 */
export function ScorecardBadge({ namespace, service, environment }: ScorecardBadgeProps) {
  const styles = useStyles2(getStyles);
  const { data } = useFetch<ScorecardResponse>(
    () => getScorecard(namespace, service, environment),
    [namespace, service, environment]
  );

  if (!data || !data.readiness || data.readiness.total === 0) {
    return null;
  }
  const { score, total } = data.readiness;
  const tone = score === total ? styles.good : score * 2 >= total ? styles.partial : styles.low;

  return (
    <Toggletip content={<ScorecardDetails data={data} />} placement="bottom">
      <button type="button" className={cx(styles.badge, tone)} data-testid="scorecard-badge">
        <Icon name={score === total ? 'check-circle' : 'info-circle'} size="sm" />
        {score}/{total} observability checks
      </button>
    </Toggletip>
  );
}

function ScorecardDetails({ data }: { data: ScorecardResponse }) {
  const styles = useStyles2(getStyles);
  const consoleInfo = data.console;
  return (
    <div className={styles.details} data-testid="scorecard-details">
      <div className={styles.sectionTitle}>Observability readiness</div>
      <ul className={styles.checkList}>
        {data.readiness.checks.map((check) => (
          <li key={check.key} className={styles.check}>
            <span
              className={check.ok ? styles.checkIconOk : styles.checkIconMissing}
              role="img"
              aria-label={check.ok ? 'Enabled' : 'Not enabled'}
            >
              <Icon name={check.ok ? 'check-circle' : 'circle'} size="sm" />
            </span>
            <span>
              {check.label}
              {!check.ok && <div className={styles.hint}>{check.hint}</div>}
            </span>
          </li>
        ))}
      </ul>
      <ConsoleLinks consoleInfo={consoleInfo} />
    </div>
  );
}

function ConsoleLinks({ consoleInfo }: { consoleInfo: ScorecardConsole }) {
  const styles = useStyles2(getStyles);
  const hasAny =
    consoleInfo.configured &&
    Boolean(
      consoleInfo.teamSlug || consoleInfo.slackChannel || consoleInfo.repositoryUrl || consoleInfo.ingresses?.length
    );
  // Unconfigured (or empty) Console → show nothing, silently.
  if (!hasAny) {
    return null;
  }
  return (
    <div className={styles.consoleSection}>
      <div className={styles.sectionTitle}>Ownership</div>
      <ul className={styles.checkList}>
        {consoleInfo.teamSlug && (
          <li className={styles.check}>
            <Icon name="users-alt" size="sm" />
            <span>
              {consoleInfo.teamSlug}
              {consoleInfo.slackChannel ? ` — ${consoleInfo.slackChannel}` : ''}
            </span>
          </li>
        )}
        {consoleInfo.repositoryUrl && (
          <li className={styles.check}>
            <Icon name="github" size="sm" />
            <a className={styles.link} href={consoleInfo.repositoryUrl} target="_blank" rel="noreferrer">
              Repository
            </a>
          </li>
        )}
        {(consoleInfo.ingresses ?? []).map((url) => (
          <li key={url} className={styles.check}>
            <Icon name="external-link-alt" size="sm" />
            <a className={styles.link} href={url} target="_blank" rel="noreferrer">
              {url.replace(/^https?:\/\//, '')}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  badge: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    padding: 1px 8px;
    border-radius: ${theme.shape.radius.pill};
    font-size: ${theme.typography.bodySmall.fontSize};
    border: 1px solid transparent;
    background: none;
    cursor: pointer;
    vertical-align: middle;
  `,
  good: css`
    color: ${theme.colors.success.text};
    border-color: ${theme.colors.success.border};
    background-color: ${theme.colors.success.transparent};
  `,
  partial: css`
    color: ${theme.colors.warning.text};
    border-color: ${theme.colors.warning.border};
    background-color: ${theme.colors.warning.transparent};
  `,
  low: css`
    color: ${theme.colors.error.text};
    border-color: ${theme.colors.error.border};
    background-color: ${theme.colors.error.transparent};
  `,
  details: css`
    max-width: 360px;
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  sectionTitle: css`
    font-weight: ${theme.typography.fontWeightMedium};
    margin-bottom: ${theme.spacing(0.5)};
  `,
  checkList: css`
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
  `,
  check: css`
    display: flex;
    align-items: flex-start;
    gap: ${theme.spacing(1)};
  `,
  checkIconOk: css`
    color: ${theme.colors.success.text};
  `,
  checkIconMissing: css`
    color: ${theme.colors.text.disabled};
  `,
  hint: css`
    color: ${theme.colors.text.secondary};
  `,
  consoleSection: css`
    margin-top: ${theme.spacing(1.5)};
    padding-top: ${theme.spacing(1)};
    border-top: 1px solid ${theme.colors.border.weak};
  `,
  link: css`
    color: ${theme.colors.text.link};
    &:hover {
      text-decoration: underline;
    }
  `,
});
