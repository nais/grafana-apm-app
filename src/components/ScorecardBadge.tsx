import React, { useCallback, useState } from 'react';
import { css, cx } from '@emotion/css';
import { AppEvents, GrafanaTheme2 } from '@grafana/data';
import { getAppEvents, locationService } from '@grafana/runtime';
import { Button, ClipboardButton, Icon, TextLink, Toggletip, useStyles2 } from '@grafana/ui';
import { getScorecard, ScorecardCheck, ScorecardConsole, ScorecardResponse } from '../api/scorecard';
import { buildAlertRuleUrl, getAlertTemplate } from '../api/client';
import { apmDocs } from '../utils/docsLinks';
import { useFetch } from '../utils/useFetch';

interface ScorecardBadgeProps {
  namespace: string;
  service: string;
  environment?: string;
}

/**
 * Per-check docs deep link (#143 Phase 1 "actionability"): every check the
 * backend can report gets the how-to that closes it. The key set is closed —
 * see `computeReadiness` in pkg/plugin/scorecard.go — so this is a frontend-only
 * mapping rather than a new API field.
 */
const CHECK_DOCS: Record<string, string> = {
  spanMetrics: apmDocs.getStarted(),
  traces: apmDocs.getStarted(),
  logs: apmDocs.logPatterns(),
  runtimeMetrics: apmDocs.getStarted(),
  browserTelemetry: apmDocs.trackFrontendErrors(),
  alertRules: apmDocs.createAlerts(),
};

/**
 * Auto-instrumentation is the one manifest block behind both span metrics (RED)
 * and runtime metrics — the OTel agent emits both. Field shape from the nais
 * Application spec (liberator `AutoInstrumentation`).
 */
const AUTO_INSTRUMENTATION_SNIPPET = `spec:
  observability:
    autoInstrumentation:
      enabled: true
      runtime: java # java | nodejs | python | dotnet | sdk`;

/** Copy-pasteable nais.yaml for the manifest-driven checks. Exported for the content test. */
export const CHECK_SNIPPETS: Record<string, string> = {
  spanMetrics: AUTO_INSTRUMENTATION_SNIPPET,
  runtimeMetrics: AUTO_INSTRUMENTATION_SNIPPET,
  logs: `spec:
  observability:
    logging:
      destinations:
        - id: loki`,
};

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
    <Toggletip
      content={<ScorecardDetails data={data} namespace={namespace} service={service} environment={environment} />}
      placement="bottom"
    >
      <button type="button" className={cx(styles.badge, tone)} data-testid="scorecard-badge">
        <Icon name={score === total ? 'check-circle' : 'info-circle'} size="sm" />
        {score}/{total} observability checks
      </button>
    </Toggletip>
  );
}

function ScorecardDetails({
  data,
  namespace,
  service,
  environment,
}: { data: ScorecardResponse } & ScorecardBadgeProps) {
  const styles = useStyles2(getStyles);
  const consoleInfo = data.console;
  return (
    <div className={styles.details} data-testid="scorecard-details">
      <div className={styles.sectionTitle}>Observability readiness</div>
      <ul className={styles.checkList}>
        {data.readiness.checks.map((check) => (
          <li key={check.key} className={cx(styles.check, check.notApplicable && styles.checkNotApplicable)}>
            <span
              className={
                check.notApplicable ? styles.checkIconNA : check.ok ? styles.checkIconOk : styles.checkIconMissing
              }
              role="img"
              aria-label={check.notApplicable ? 'Not applicable' : check.ok ? 'Enabled' : 'Not enabled'}
            >
              <Icon name={check.notApplicable ? 'minus-circle' : check.ok ? 'check-circle' : 'circle'} size="sm" />
            </span>
            {/* div, not span: the hint below is block-level and a div inside a span is invalid HTML */}
            <div>
              {check.label}
              {check.notApplicable && <span className={styles.naTag}>N/A</span>}
              {!check.ok && (
                <div className={styles.hint}>
                  {check.hint}
                  <CheckActions check={check} namespace={namespace} service={service} environment={environment} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <ConsoleLinks consoleInfo={consoleInfo} />
    </div>
  );
}

/**
 * One-click follow-ups for a check that isn't passing: the docs how-to, the
 * `nais.yaml` block to paste for manifest-driven checks, and — for alert rules —
 * the prefilled new-rule form the backend already renders (#65 template).
 *
 * A not-applicable check keeps the docs link (its hint says "if this service
 * gets a frontend…") but not the fix actions: nothing needs fixing.
 */
function CheckActions({ check, namespace, service, environment }: { check: ScorecardCheck } & ScorecardBadgeProps) {
  const styles = useStyles2(getStyles);
  const [creatingAlert, setCreatingAlert] = useState(false);
  const docsHref = CHECK_DOCS[check.key];
  const snippet = check.notApplicable ? undefined : CHECK_SNIPPETS[check.key];
  const canCreateAlert = !check.notApplicable && check.key === 'alertRules';

  const onCreateAlert = useCallback(async () => {
    setCreatingAlert(true);
    try {
      const template = await getAlertTemplate('error-rate', {
        namespace: namespace || undefined,
        service,
        environment: environment || undefined,
      });
      locationService.push(buildAlertRuleUrl(template.url));
    } catch (err) {
      setCreatingAlert(false);
      getAppEvents().publish({
        type: AppEvents.alertError.name,
        payload: ['Could not prepare alert rule', err instanceof Error ? err.message : String(err)],
      });
    }
  }, [namespace, service, environment]);

  if (!docsHref && !snippet && !canCreateAlert) {
    return null;
  }
  return (
    <div className={styles.actions} data-testid={`check-actions-${check.key}`}>
      {docsHref && (
        <TextLink href={docsHref} external variant="bodySmall">
          Docs
        </TextLink>
      )}
      {snippet && (
        <ClipboardButton variant="secondary" fill="text" size="sm" icon="copy" getText={() => snippet}>
          Copy nais.yaml
        </ClipboardButton>
      )}
      {canCreateAlert && (
        <Button variant="secondary" fill="text" size="sm" icon="bell" disabled={creatingAlert} onClick={onCreateAlert}>
          Alert on error rate
        </Button>
      )}
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
  checkIconNA: css`
    color: ${theme.colors.text.disabled};
  `,
  checkNotApplicable: css`
    color: ${theme.colors.text.secondary};
  `,
  naTag: css`
    margin-left: ${theme.spacing(0.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.disabled};
  `,
  hint: css`
    color: ${theme.colors.text.secondary};
  `,
  actions: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: ${theme.spacing(1)};
    margin-top: ${theme.spacing(0.25)};
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
