import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getAppEvents, locationService } from '@grafana/runtime';
import { AppEvents, GrafanaTheme2 } from '@grafana/data';
import { Badge, Button, Icon, LoadingPlaceholder, TextLink, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';
import {
  AlertTemplateKind,
  ServiceAlertRule,
  buildAlertRuleUrl,
  getAlertTemplate,
  getServiceAlerts,
} from '../../api/client';
import { apmDocs } from '../../utils/docsLinks';
import { useFetch } from '../../utils/useFetch';
import { useUrlParams } from '../../utils/useUrlState';
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
  window?: 'fast' | 'slow';
}

const ALERT_TEMPLATES: AlertTemplateCard[] = [
  {
    key: 'error-rate',
    kind: 'error-rate',
    title: 'Error rate',
    description: 'Fires when more than 5% of requests to this service fail over a 5m window.',
  },
  {
    key: 'slo-fast',
    kind: 'slo-burn-rate',
    window: 'fast',
    title: 'SLO fast burn (page)',
    description: 'Multi-window burn-rate rule that pages when the error budget burns 14.4× over 1h.',
  },
  {
    key: 'slo-slow',
    kind: 'slo-burn-rate',
    window: 'slow',
    title: 'SLO slow burn (ticket)',
    description: 'Tickets when the error budget burns 6× over 6h — a slower, non-paging signal.',
  },
  {
    key: 'new-exceptions',
    kind: 'new-exceptions',
    title: 'New exception types',
    description: 'Fires when an exception type appears that was not seen in the previous 7 days. Requires logs (Loki).',
  },
  {
    key: 'web-vitals',
    kind: 'web-vitals',
    title: 'Web Vitals (LCP)',
    description: 'Fires when LCP p75 exceeds 2.5s (Core Web Vitals "poor"). Requires frontend (Faro) telemetry.',
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
  const [searchParams, setSearchParams] = useSearchParams();
  const updateParams = useUrlParams();

  const { data, loading, error } = useFetch(() => getServiceAlerts(namespace, service), [namespace, service]);
  const rules = data?.rules ?? [];

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
          window: card.window,
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

        {loading && !data ? (
          <LoadingPlaceholder text="Loading alert rules…" />
        ) : error ? (
          <div className={styles.message}>Could not load alert rules for this service.</div>
        ) : data?.unavailable ? (
          <div className={styles.message}>Alert rules are currently unavailable.</div>
        ) : rules.length === 0 ? (
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
            Pre-filled rules for this service — opens Grafana&apos;s alert editor and returns here on save.
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
                disabled={creating !== null}
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
                ) : (
                  <TextLink href={`/alerting/list?search=${encodeURIComponent(rule.name)}`} variant="bodySmall">
                    Open in Grafana
                  </TextLink>
                )}
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
});
