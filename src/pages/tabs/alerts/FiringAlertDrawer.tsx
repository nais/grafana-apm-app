import React, { useEffect, useMemo, useState } from 'react';
import { getBackendSrv } from '@grafana/runtime';
import { GrafanaTheme2 } from '@grafana/data';
import { Badge, Button, ControlledCollapse, Drawer, Icon, Spinner, TextLink, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';
import { ServiceAlertRule } from '../../../api/client';
import { PLUGIN_BASE_URL } from '../../../constants';
import { resolveIssueLink } from './resolveIssueLink';

interface FiringAlertDrawerProps {
  /** The rule the `firingAlert` param resolved to, or undefined when it matched
   * nothing in the current rule set (drawer degrades to "unavailable"). */
  rule?: ServiceAlertRule;
  /** The rule name from the URL param — shown in the header even when the rule
   * could not be resolved. */
  ruleName: string;
  namespace: string;
  service: string;
  environment?: string;
  /** True while the alerts fetch that resolves `rule` is still in flight. */
  loading?: boolean;
  onClose: () => void;
}

/** How many firing instances to render before collapsing the rest behind a hint. */
const INSTANCE_DISPLAY_CAP = 10;

/**
 * Read-only firing-alert detail drawer (#32). Opened purely from the
 * `firingAlert=<ruleName>` URL param (docs/url-contract.md) so it is shareable,
 * and reuses the ExceptionDrawer's chrome/interaction model for consistency.
 *
 * It renders over the inline firing state #33 Phase 1 already surfaces
 * (ServiceAlertRule.firingState + expression/forDuration/runbookUrl) — no new
 * backend fetch for the basics. Deploy correlation and the related-Issue link
 * are best-effort side fetches that degrade silently.
 *
 * Capability-gated: when the rule can't be resolved or carries no firing state,
 * it degrades to a "state unavailable" notice rather than erroring the page.
 */
export function FiringAlertDrawer({
  rule,
  ruleName,
  namespace,
  service,
  environment,
  loading = false,
  onClose,
}: FiringAlertDrawerProps) {
  const styles = useStyles2(getStyles);
  const fs = rule?.firingState;
  const active = fs?.state === 'firing' || fs?.state === 'pending';
  const instances = useMemo(() => fs?.instances ?? [], [fs]);
  const activeAtMs = fs?.activeSince ? Date.parse(fs.activeSince) : NaN;

  // Best-effort: the last deploy annotation before the alert started firing —
  // an alert firing shortly after a deploy is the single most useful
  // correlation (#64 deploy-annotation contract, reused via its tag scheme).
  const deployKey = Number.isFinite(activeAtMs) ? `${service}:${environment ?? ''}:${activeAtMs}` : null;
  const [lastDeploy, setLastDeploy] = useState<{ key: string; version: string; timeMs: number } | null>(null);
  useEffect(() => {
    if (!deployKey) {
      return;
    }
    let cancelled = false;
    fetchLastDeployBefore(service, environment, activeAtMs)
      .then((deploy) => {
        if (!cancelled) {
          setLastDeploy(deploy ? { key: deployKey, ...deploy } : null);
        }
      })
      .catch(() => {
        // Deploy correlation is best-effort — no marker on failure.
      });
    return () => {
      cancelled = true;
    };
  }, [service, environment, activeAtMs, deployKey]);
  const deployBeforeFiring = lastDeploy?.key === deployKey ? lastDeploy : null;

  // Related-Issue link — only when an instance's labels confidently resolve to
  // an issue identity, never a guessed one (#32).
  const issueLink = useMemo(() => {
    for (const inst of instances) {
      const resolved = resolveIssueLink(inst.labels);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }, [instances]);

  const nsSegment = encodeURIComponent(namespace || '_');
  const envParam = environment ? `&environment=${encodeURIComponent(environment)}` : '';

  // RED panel scoped to [activeAt-15m, now] — the firing window with lead-in.
  const redFrom = Number.isFinite(activeAtMs) ? new Date(activeAtMs - 15 * 60_000).toISOString() : 'now-1h';
  const redPanelUrl = `${PLUGIN_BASE_URL}/services/${nsSegment}/${encodeURIComponent(service)}?tab=backend&from=${encodeURIComponent(redFrom)}&to=now${envParam}`;

  const issueUrl = issueLink
    ? 'issueId' in issueLink
      ? `${PLUGIN_BASE_URL}/services/${nsSegment}/${encodeURIComponent(service)}?tab=issues${envParam}&issueId=${encodeURIComponent(issueLink.issueId)}`
      : `${PLUGIN_BASE_URL}/services/${nsSegment}/${encodeURIComponent(service)}?tab=frontend${envParam}&exceptionHash=${encodeURIComponent(issueLink.exceptionHash)}`
    : null;

  // "Open in Grafana Alerting": no rule UID is carried on the summary (the
  // ruler→Grafana UID join is out of scope, #33 Phase 2), so we fall back to
  // the name-search deep link, which always resolves.
  const grafanaUrl = `/alerting/list?search=${encodeURIComponent(ruleName)}`;

  const shown = instances.slice(0, INSTANCE_DISPLAY_CAP);
  const overflow = instances.length - shown.length;

  return (
    <Drawer
      title={ruleName || 'Firing alert'}
      subtitle={rule?.summary || rule?.description || undefined}
      onClose={onClose}
      closeOnMaskClick={true}
      size="md"
    >
      <div className={styles.container}>
        {/* Header strip: source + state + duration */}
        <div className={styles.headerStrip}>
          {rule?.source === 'grafana' ? (
            <Badge text="grafana" color="blue" icon="bell" />
          ) : rule?.source === 'mimir' ? (
            <Badge text="mimir" color="purple" icon="graph-bar" />
          ) : null}
          {fs?.state ? (
            <Badge
              text={fs.state}
              color={fs.state === 'firing' ? 'red' : fs.state === 'pending' ? 'orange' : 'green'}
            />
          ) : null}
          {active && fs?.activeSince && (
            <span className={styles.meta}>firing for {formatDuration(fs.activeSince)}</span>
          )}
          {rule?.severity && <span className={styles.meta}>severity: {rule.severity}</span>}
        </div>

        {loading && !rule ? (
          <div className={styles.notice}>
            <Spinner inline /> Loading alert details…
          </div>
        ) : !rule || !fs || !fs.state ? (
          // Capability-gated degrade: no firing data for this rule.
          <div className={styles.notice}>
            Firing state is unavailable for this alert. Open it in Grafana Alerting for the live state.
          </div>
        ) : (
          <>
            {/* Condition: current value + evaluation window; raw expression
                collapsible (opaque PromQL/LogQL kept out of the way). */}
            <section className={styles.section}>
              <h4 className={styles.sectionTitle}>Condition</h4>
              <div className={styles.kvGrid}>
                {fs.value !== undefined && (
                  <>
                    <span className={styles.kvKey}>Current value</span>
                    <span className={styles.kvVal}>{fs.value}</span>
                  </>
                )}
                {rule.forDuration ? (
                  <>
                    <span className={styles.kvKey}>Evaluation window</span>
                    <span className={styles.kvVal}>{formatSeconds(rule.forDuration)}</span>
                  </>
                ) : null}
                <span className={styles.kvKey}>Active instances</span>
                <span className={styles.kvVal}>{fs.activeCount}</span>
              </div>
              {rule.expression && (
                <ControlledCollapse label="Raw expression" isOpen={false}>
                  <pre className={styles.expr}>{rule.expression}</pre>
                </ControlledCollapse>
              )}
            </section>

            {/* Instance labels — capped/paginated for high-cardinality rules. */}
            {instances.length > 0 && (
              <section className={styles.section}>
                <h4 className={styles.sectionTitle}>Firing instances ({fs.activeCount})</h4>
                <div className={styles.instanceList}>
                  {shown.map((inst, i) => (
                    <div key={i} className={styles.instanceRow}>
                      <span className={styles.instanceLabels}>
                        {formatInstanceLabels(inst.labels) || '(no labels)'}
                      </span>
                      {inst.value !== undefined && <span className={styles.instanceValue}>= {inst.value}</span>}
                    </div>
                  ))}
                </div>
                {(overflow > 0 || fs.instancesTruncated) && (
                  <span className={styles.meta}>
                    {overflow > 0 ? `+${overflow} more shown in Grafana` : 'more instances than shown'}
                    {fs.instancesTruncated ? ' (server-capped)' : ''}
                  </span>
                )}
              </section>
            )}

            {/* Annotations, verbatim. */}
            {(rule.summary || rule.description || rule.runbookUrl) && (
              <section className={styles.section}>
                <h4 className={styles.sectionTitle}>Annotations</h4>
                {rule.summary && (
                  <div className={styles.annotation}>
                    <span className={styles.annotationKey}>summary</span>
                    <span className={styles.annotationVal}>{rule.summary}</span>
                  </div>
                )}
                {rule.description && (
                  <div className={styles.annotation}>
                    <span className={styles.annotationKey}>description</span>
                    <span className={styles.annotationVal}>{rule.description}</span>
                  </div>
                )}
                {rule.runbookUrl && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="book"
                    onClick={() => window.open(rule.runbookUrl, '_blank', 'noopener,noreferrer')}
                  >
                    Open runbook
                  </Button>
                )}
              </section>
            )}

            {/* Context strip: deploy correlation + RED panel + related Issue. */}
            <section className={styles.section}>
              <h4 className={styles.sectionTitle}>Context</h4>
              <div className={styles.contextList}>
                {deployBeforeFiring && (
                  <div className={styles.contextItem}>
                    <Icon name="rocket" size="sm" />
                    <span>
                      Last deploy before firing: <strong>{deployBeforeFiring.version}</strong> (
                      {formatDuration(new Date(deployBeforeFiring.timeMs).toISOString())} before)
                    </span>
                  </div>
                )}
                <div className={styles.contextItem}>
                  <Icon name="chart-line" size="sm" />
                  <a href={redPanelUrl} target="_blank" rel="noopener noreferrer" className={styles.contextLink}>
                    Service metrics around the firing window
                  </a>
                </div>
                {issueUrl && (
                  <div className={styles.contextItem}>
                    <Icon name="bug" size="sm" />
                    <a href={issueUrl} target="_blank" rel="noopener noreferrer" className={styles.contextLink}>
                      Related issue
                    </a>
                  </div>
                )}
              </div>
            </section>
          </>
        )}

        {/* Footer: Grafana Alerting deep link (name-search fallback). */}
        <div className={styles.footer}>
          <TextLink href={grafanaUrl} variant="bodySmall">
            Open in Grafana Alerting
          </TextLink>
        </div>
      </div>
    </Drawer>
  );
}

/**
 * Best-effort fetch of the most recent deploy annotation strictly before
 * `beforeMs`, reusing the #64 deploy-annotation tag scheme
 * (`buildDeployAnnotationsLayer`). Returns null on any failure or no match.
 */
async function fetchLastDeployBefore(
  service: string,
  environment: string | undefined,
  beforeMs: number
): Promise<{ version: string; timeMs: number } | null> {
  const tags = ['nais-apm:deploy', `service:${service}`];
  // A multi-env selection can't be AND-ed via repeated tags — only scope to a
  // single environment (matches the backend's fetchDeployAnnotations).
  if (environment && !environment.includes(',')) {
    tags.push(`env:${environment}`);
  }
  const annotations: Array<{ time: number; text: string; tags: string[] }> = await getBackendSrv().get(
    '/api/annotations',
    {
      tags,
      // Look back 7d before the alert started for the landing deploy.
      from: beforeMs - 7 * 24 * 3600_000,
      to: beforeMs,
      limit: 100,
    }
  );
  let best: { version: string; timeMs: number } | null = null;
  for (const ann of annotations ?? []) {
    if (ann.time >= beforeMs) {
      continue;
    }
    const version = (ann.tags ?? []).find((t) => t.startsWith('version:'))?.slice('version:'.length) || ann.text;
    if (!version) {
      continue;
    }
    if (!best || ann.time > best.timeMs) {
      best = { version, timeMs: ann.time };
    }
  }
  return best;
}

/** Render an instance's label set as a compact `k="v"` list, dropping noisy
 * internal labels (matches the Alerts tab cell). */
function formatInstanceLabels(labels?: Record<string, string>): string {
  if (!labels) {
    return '';
  }
  return Object.entries(labels)
    .filter(([k]) => k !== 'alertname' && !k.startsWith('__'))
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ');
}

/** Human duration between an ISO timestamp and now ("5m", "2h", "3d"). */
function formatDuration(isoString: string): string {
  const then = Date.parse(isoString);
  if (!Number.isFinite(then)) {
    return isoString;
  }
  const diffMs = Math.max(0, Date.now() - then);
  if (diffMs < 60_000) {
    return 'less than a minute';
  }
  if (diffMs < 3_600_000) {
    return `${Math.floor(diffMs / 60_000)}m`;
  }
  if (diffMs < 86_400_000) {
    return `${Math.floor(diffMs / 3_600_000)}h`;
  }
  return `${Math.floor(diffMs / 86_400_000)}d`;
}

/** Render a `for` window given in seconds as a compact duration. */
function formatSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${Math.round(seconds / 360) / 10}h`;
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(2.5)};
  `,
  headerStrip: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: ${theme.spacing(1)};
  `,
  meta: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  notice: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    padding: ${theme.spacing(1)} 0;
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  sectionTitle: css`
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    margin: 0;
    border-bottom: 1px solid ${theme.colors.border.weak};
    padding-bottom: ${theme.spacing(0.5)};
  `,
  kvGrid: css`
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: ${theme.spacing(0.5)} ${theme.spacing(2)};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  kvKey: css`
    color: ${theme.colors.text.secondary};
  `,
  kvVal: css`
    color: ${theme.colors.text.primary};
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
  expr: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  `,
  instanceList: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
  `,
  instanceRow: css`
    display: flex;
    align-items: baseline;
    gap: ${theme.spacing(1)};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  instanceLabels: css`
    color: ${theme.colors.text.primary};
    word-break: break-all;
  `,
  instanceValue: css`
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
  `,
  annotation: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.25)};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  annotationKey: css`
    color: ${theme.colors.text.secondary};
    font-family: ${theme.typography.fontFamilyMonospace};
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.05em;
  `,
  annotationVal: css`
    color: ${theme.colors.text.primary};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  contextList: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.75)};
  `,
  contextItem: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  contextLink: css`
    color: ${theme.colors.text.link};
    text-decoration: underline;
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    padding-top: ${theme.spacing(1.5)};
    border-top: 1px solid ${theme.colors.border.weak};
  `,
});
