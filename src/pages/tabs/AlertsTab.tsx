import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getAppEvents, locationService } from '@grafana/runtime';
import { AppEvents, GrafanaTheme2 } from '@grafana/data';
import { Badge, Button, ClipboardButton, Icon, LoadingPlaceholder, TextLink, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';
import {
  AlertTemplateKind,
  ServiceAlertRule,
  buildAlertRuleUrl,
  getAlertTemplate,
  getNewExceptionsPrometheusRule,
  getServiceAlerts,
} from '../../api/client';
import { apmDocs } from '../../utils/docsLinks';
import { useFetch } from '../../utils/useFetch';
import { useUrlParams } from '../../utils/useUrlState';
import { hasAlertRoutingContext } from '../../utils/alertRouting';
import { FiringAlertDrawer } from './alerts/FiringAlertDrawer';

interface AlertsTabProps {
  service: string;
  namespace: string;
  environment?: string;
}

/**
 * One create-alert template surfaced as a card. Each maps to a backend alert
 * template (pkg/plugin/alerttemplates.go). `exception-spike` is intentionally
 * NOT here: it needs a specific exception hash, so it stays on the Issues tab's
 * ExceptionDrawer where that context exists (this tab links there instead).
 */
interface AlertTemplateCard {
  key: string;
  kind: AlertTemplateKind;
  title: string;
  description: string;
}

const ALERT_TEMPLATES: AlertTemplateCard[] = [
  {
    key: 'custom',
    kind: 'custom',
    title: 'Custom alert',
    description:
      'Start with routing labels, warning severity and a matching team folder pre-filled when available. You can change severity to info or critical. Add a name, query and alert condition. Scope the query to the app and environment yourself.',
  },
  {
    key: 'crash-loop-back-off',
    kind: 'crash-loop-back-off',
    title: 'CrashLoopBackOff',
    description:
      'Fires when a container stays in CrashLoopBackOff for 5m. Watches all pods in the selected team namespace and environment.',
  },
  {
    key: 'new-exceptions',
    kind: 'new-exceptions',
    title: 'New frontend exceptions',
    description:
      'Fires when a frontend exception was seen in the last 30m but not in the preceding 7 days. Uses the Faro recording rule in Mimir; review and save in Grafana.',
  },
  {
    key: 'web-vitals',
    kind: 'web-vitals',
    title: 'Web Vitals (LCP)',
    description: 'Fires when LCP p75 exceeds 2.5s. Requires frontend (Faro) telemetry.',
  },
];

/**
 * Alerts tab (#32/#33 home). Answers one question: "what's watching this
 * service, and is anything firing?" It merges the Mimir ruler and Grafana
 * unified-alerting rules that mention this service (backend
 * /services/{ns}/{svc}/alerts, filtered by the conservative ruleMentionsService
 * matcher) and offers the create-alert templates in one coherent place.
 *
 * Scope: the rule list + read-only firing state (#33) + the create-alert
 * affordance. Each rule's current state, value and firing instances come inline
 * from the rules API (ServiceAlertRule.firingState); the #32 firing-alert detail
 * drawer and Alertmanager silences are the remaining follow-up.
 */
export function AlertsTab({ service, namespace, environment }: AlertsTabProps) {
  const styles = useStyles2(getStyles);
  const canRouteAlert = hasAlertRoutingContext(namespace, environment);
  const [searchParams, setSearchParams] = useSearchParams();
  const updateParams = useUrlParams();

  const { data, loading, error } = useFetch(
    () => getServiceAlerts(namespace, service, environment),
    [namespace, service, environment]
  );
  const rules = data?.rules ?? [];

  // #123 Phase 1: the one alert path that does NOT need per-team Grafana
  // folders/contact points to be sorted out first — a PrometheusRule the team
  // commits, delivered by the alerting they already run. Rendering it is pure
  // string formatting on the backend, so it fetches with the tab.
  const {
    data: prometheusRule,
    loading: prometheusRuleLoading,
    error: prometheusRuleError,
  } = useFetch(
    () => getNewExceptionsPrometheusRule({ namespace, service, environment }),
    [namespace, service, environment]
  );

  // The #32 firing-alert detail drawer is opened purely from the URL
  // (docs/url-contract.md): `firingAlert=<ruleName>` is shareable and resolves
  // against the rule set this tab already loaded — no new fetch.
  const firingAlert = searchParams.get('firingAlert') ?? '';
  const selectedRule = firingAlert ? rules.find((r) => r.name === firingAlert) : undefined;
  const openDrawer = useCallback((name: string) => updateParams({ firingAlert: name }), [updateParams]);
  const closeDrawer = useCallback(() => updateParams({ firingAlert: null }), [updateParams]);

  const [creating, setCreating] = useState<string | null>(null);
  const createAlert = useCallback(
    async (card: AlertTemplateCard) => {
      setCreating(card.key);
      try {
        const template = await getAlertTemplate(card.kind, {
          namespace: namespace || undefined,
          service,
          environment: environment || undefined,
        });
        locationService.push(buildAlertRuleUrl(template.url));
      } catch (err) {
        setCreating(null);
        getAppEvents().publish({
          type: AppEvents.alertError.name,
          payload: ['Could not prepare alert rule', err instanceof Error ? err.message : String(err)],
        });
      }
    },
    [namespace, service, environment]
  );

  const goToIssues = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', 'issues');
      return next;
    });
  }, [setSearchParams]);

  return (
    <div className={styles.container}>
      <section className={styles.panel}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>
            <Icon name="bell" className={styles.titleIcon} />
            Alert rules{' '}
            <Badge
              text="Under construction"
              color="orange"
              tooltip="Per-team alert folders and configuration are still being set up across the platform — where a rule lands may change. You can create alerts from templates today."
            />
          </h3>
          <span className={styles.sectionSubtitle}>
            Rules watching this service, merged from Mimir and Grafana alerting.
          </span>
        </div>

        {data?.partial && (
          <div className={styles.message}>Some alert rule sources are unavailable. The list may be incomplete.</div>
        )}
        {loading && !data ? (
          <LoadingPlaceholder text="Loading alert rules…" />
        ) : error ? (
          <div className={styles.message}>Could not load alert rules for this service.</div>
        ) : data?.unavailable ? (
          <div className={styles.message}>Alert rules are currently unavailable.</div>
        ) : rules.length === 0 && data?.partial ? null : rules.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyText}>No alerts configured for this service.</div>
            <div className={styles.emptyHint}>Create one below to get notified when this service degrades.</div>
          </div>
        ) : (
          <AlertRulesTable rules={rules} styles={styles} onOpenDetail={openDrawer} />
        )}
      </section>

      <section className={styles.panel}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Create alert</h3>
          <span className={styles.sectionSubtitle}>
            {canRouteAlert
              ? 'Rules with pre-filled routing labels for Slack notifications to your team. Review and save in Grafana, using notification policies (not a direct contact point). Check Preview routing before saving to confirm delivery to the intended Slack channel.'
              : 'Select a team and exactly one environment to create a Grafana alert that matches its notification policy.'}
          </span>
        </div>

        <div className={styles.cards}>
          {ALERT_TEMPLATES.map((card) => (
            <div key={card.key} className={styles.card}>
              <div className={styles.cardBody}>
                <div className={styles.cardTitle}>{card.title}</div>
                <div className={styles.cardDesc}>{card.description}</div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                icon="bell"
                disabled={creating !== null || !canRouteAlert}
                onClick={() => createAlert(card)}
              >
                {creating === card.key ? 'Preparing…' : 'Create alert'}
              </Button>
            </div>
          ))}

          {/* Exception-spike alerts are per-exception (need a hash); their home
              is the Issues tab drawer. Offer the path, not a broken button. */}
          <div className={styles.card}>
            <div className={styles.cardBody}>
              <div className={styles.cardTitle}>Exception spike</div>
              <div className={styles.cardDesc}>
                Alert on a specific frontend exception spiking. Pick the exception on the Issues tab to create it.
              </div>
            </div>
            <Button size="sm" variant="secondary" icon="bug" onClick={goToIssues}>
              Go to Issues
            </Button>
          </div>
        </div>

        <div className={styles.docs}>
          <TextLink href={apmDocs.createAlerts()} external variant="bodySmall">
            About alert templates
          </TextLink>
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Alert on new frontend exceptions</h3>
          <span className={styles.sectionSubtitle}>
            The templates above open rules you review and save in Grafana. This PrometheusRule is managed as code:
            commit it alongside your app and deploy it to the cluster you want watched. It alerts on frontend exceptions
            not seen in the preceding 7 days, not on APM issue status. Notifications follow your team&apos;s existing
            alert routing; Slack delivery depends on that configuration. The environment comes from the cluster where
            you deploy the rule. Requires frontend (Faro) telemetry.
          </span>
        </div>

        {prometheusRuleLoading ? (
          <LoadingPlaceholder text="Preparing the PrometheusRule…" />
        ) : prometheusRuleError || !prometheusRule ? (
          <div className={styles.message}>Could not render the PrometheusRule for this service.</div>
        ) : (
          <>
            <div className={styles.yamlActions}>
              <ClipboardButton size="sm" variant="secondary" icon="copy" getText={() => prometheusRule}>
                Copy manifest
              </ClipboardButton>
            </div>
            <pre className={styles.yaml}>{prometheusRule}</pre>
            {/* The rule only sees exceptions carrying a session_id, so a
                backend-only app gets one that never fires — and a rule that
                never fires looks identical to a healthy service. Give the
                one-shot check rather than building a probe for it. */}
            <div className={styles.yamlHint}>
              Before relying on it, confirm the series exists in your tenant:{' '}
              <code>{`count(loki:apm:exception_sessions:count1m{service_name="${service}"})`}</code>
            </div>
          </>
        )}
      </section>

      {firingAlert && (
        <FiringAlertDrawer
          rule={selectedRule}
          ruleName={firingAlert}
          namespace={namespace}
          service={service}
          environment={environment}
          loading={loading}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}

function AlertRulesTable({
  rules,
  styles,
  onOpenDetail,
}: {
  rules: ServiceAlertRule[];
  styles: ReturnType<typeof getStyles>;
  onOpenDetail: (ruleName: string) => void;
}) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Rule</th>
          <th className={styles.narrowCol}>Source</th>
          <th className={styles.narrowCol}>State</th>
          <th className={styles.narrowCol} aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {rules.map((rule) => {
          // A row is "actionable" (has a detail drawer to open) only when it is
          // actively firing or pending (#32) — inactive rules have no instances.
          const isActive = rule.firingState?.state === 'firing' || rule.firingState?.state === 'pending';
          return (
            <tr key={`${rule.source ?? ''}:${rule.groupName}:${rule.name}`}>
              <td>
                {isActive ? (
                  <button type="button" className={styles.ruleNameButton} onClick={() => onOpenDetail(rule.name)}>
                    {rule.name}
                  </button>
                ) : (
                  <div className={styles.ruleName}>{rule.name}</div>
                )}
                {(rule.summary || rule.description) && (
                  <div className={styles.ruleSummary}>{rule.summary || rule.description}</div>
                )}
              </td>
              <td className={styles.narrowCol}>
                {rule.source === 'grafana' ? (
                  <Badge text="grafana" color="blue" icon="bell" />
                ) : (
                  <Badge text="mimir" color="purple" icon="graph-bar" />
                )}
              </td>
              <td>
                <FiringStateCell rule={rule} />
              </td>
              <td className={styles.narrowCol}>
                {isActive ? (
                  <Button size="sm" variant="secondary" fill="text" onClick={() => onOpenDetail(rule.name)}>
                    Details
                  </Button>
                ) : rule.source === 'grafana' ? (
                  <TextLink href={`/alerting/list?search=${encodeURIComponent(rule.name)}`} variant="bodySmall">
                    Open in Grafana
                  </TextLink>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * The read-only firing-state cell (#33): the current state badge plus, for an
 * active rule, its current value and the labels of the instances that are
 * firing — derived from the inline active instances the rules API returns.
 * Renders a dash for a rule that has never reported a state.
 */
export function FiringStateCell({ rule }: { rule: ServiceAlertRule }) {
  const styles = useStyles2(getStyles);
  const fs = rule.firingState;
  if (!fs || !fs.state) {
    return <span className={styles.muted}>—</span>;
  }

  const active = fs.state === 'firing' || fs.state === 'pending';
  const instances = fs.instances ?? [];
  return (
    <div className={styles.stateCell}>
      <Badge text={fs.state} color={fs.state === 'firing' ? 'red' : fs.state === 'pending' ? 'orange' : 'green'} />
      {active && fs.value !== undefined && <span className={styles.stateValue}>current value {fs.value}</span>}
      {active && fs.activeSince && <span className={styles.stateMeta}>since {formatRelativeTime(fs.activeSince)}</span>}
      {active && instances.length > 0 && (
        <div className={styles.instanceLabels}>
          {instances.map((inst, i) => (
            <span key={i} className={styles.instanceLabel} title={formatInstanceLabels(inst.labels)}>
              {formatInstanceLabels(inst.labels) || '(no labels)'}
              {inst.value !== undefined ? ` = ${inst.value}` : ''}
            </span>
          ))}
          {fs.instancesTruncated && <span className={styles.stateMeta}>…more</span>}
        </div>
      )}
    </div>
  );
}

/** Render an instance's label set as a compact `k="v"` list, dropping the noisy
 * alertname/internal labels that don't help disambiguate instances. */
function formatInstanceLabels(labels?: Record<string, string>): string {
  if (!labels) {
    return '';
  }
  return Object.entries(labels)
    .filter(([k]) => k !== 'alertname' && !k.startsWith('__'))
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ');
}

/** Relative "5m ago" / "2h ago" formatting for an ISO timestamp. */
function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const diffMs = Date.now() - date.getTime();
  if (isNaN(diffMs) || diffMs < 0) {
    return isoString;
  }
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
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(2)};
  `,
  panel: css`
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
  `,
  sectionHeader: css`
    margin-bottom: ${theme.spacing(1.5)};
  `,
  sectionTitle: css`
    margin: 0;
    font-size: ${theme.typography.h4.fontSize};
    display: flex;
    align-items: center;
  `,
  titleIcon: css`
    margin-right: ${theme.spacing(0.75)};
  `,
  sectionSubtitle: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  message: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  empty: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(1)} 0;
  `,
  emptyText: css`
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  emptyHint: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    th {
      text-align: left;
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      color: ${theme.colors.text.secondary};
      padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
      border-bottom: 1px solid ${theme.colors.border.weak};
    }
    td {
      padding: ${theme.spacing(1)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: top;
    }
    tr:last-child td {
      border-bottom: none;
    }
  `,
  narrowCol: css`
    width: 1%;
    white-space: nowrap;
  `,
  ruleName: css`
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  ruleNameButton: css`
    font-weight: ${theme.typography.fontWeightMedium};
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: ${theme.colors.text.link};
    text-align: left;
    &:hover {
      text-decoration: underline;
    }
  `,
  ruleSummary: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  muted: css`
    color: ${theme.colors.text.disabled};
  `,
  stateCell: css`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: ${theme.spacing(0.5)};
  `,
  stateValue: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    font-family: ${theme.typography.fontFamilyMonospace};
    color: ${theme.colors.text.primary};
  `,
  stateMeta: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  instanceLabels: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.25)};
  `,
  instanceLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    font-family: ${theme.typography.fontFamilyMonospace};
    color: ${theme.colors.text.secondary};
    max-width: 32ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  cards: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: ${theme.spacing(1.5)};
  `,
  card: css`
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: ${theme.spacing(1.5)};
    padding: ${theme.spacing(1.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    align-items: flex-start;
  `,
  cardBody: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
  `,
  cardTitle: css`
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  cardDesc: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  docs: css`
    margin-top: ${theme.spacing(1.5)};
  `,
  yamlHint: css`
    margin-top: ${theme.spacing(1)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  yamlActions: css`
    display: flex;
    justify-content: flex-end;
    margin-bottom: ${theme.spacing(1)};
  `,
  yaml: css`
    margin: 0;
    padding: ${theme.spacing(1.5)};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    line-height: 1.5;
    overflow-x: auto;
    white-space: pre;
  `,
});
