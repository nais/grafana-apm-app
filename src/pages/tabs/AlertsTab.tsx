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
 * v1 scope: the rule list + create-alert affordance. Per-rule firing-state
 * DETAIL (active instance, value vs threshold, since when) is the #32/#33
 * follow-up — the ServiceAlertRule.firingState field is the seam, rendered as
 * "—" until that enrichment lands.
 */
export function AlertsTab({ service, namespace, environment }: AlertsTabProps) {
  const styles = useStyles2(getStyles);
  const [, setSearchParams] = useSearchParams();

  const { data, loading, error } = useFetch(() => getServiceAlerts(namespace, service), [namespace, service]);
  const rules = data?.rules ?? [];

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
            Alert rules
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
          <AlertRulesTable rules={rules} styles={styles} />
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
    </div>
  );
}

function AlertRulesTable({ rules, styles }: { rules: ServiceAlertRule[]; styles: ReturnType<typeof getStyles> }) {
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
        {rules.map((rule) => (
          <tr key={`${rule.source ?? ''}:${rule.groupName}:${rule.name}`}>
            <td>
              <div className={styles.ruleName}>{rule.name}</div>
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
            <td className={styles.narrowCol}>
              {/*
                #32/#33 seam: firingState carries the active-instance detail
                (firing/pending, since when, value vs threshold) once the
                Alertmanager fetch lands. Until then the list shows only that
                the rule exists — a dash, never a fabricated state.
              */}
              {rule.firingState ? (
                <Badge
                  text={rule.firingState.state}
                  color={
                    rule.firingState.state === 'firing'
                      ? 'red'
                      : rule.firingState.state === 'pending'
                        ? 'orange'
                        : 'green'
                  }
                />
              ) : (
                <span className={styles.muted}>—</span>
              )}
            </td>
            <td className={styles.narrowCol}>
              <TextLink href={`/alerting/list?search=${encodeURIComponent(rule.name)}`} variant="bodySmall">
                Open in Grafana
              </TextLink>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
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
  ruleSummary: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  muted: css`
    color: ${theme.colors.text.disabled};
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
