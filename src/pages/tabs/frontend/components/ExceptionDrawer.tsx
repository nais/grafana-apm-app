import React, { useEffect, useRef, useState } from 'react';
import { Drawer, Icon, Spinner, Alert, useStyles2, Combobox, Badge, Tooltip } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { otel } from '../../../../otelconfig';
import { PLUGIN_BASE_URL } from '../../../../constants';
import { sanitizeLabelValue } from '../../../../utils/sanitize';
import { usePluginLabelOverrides } from '../../../../utils/datasources';
import { useTimeRange } from '../../../../utils/timeRange';
import { StackTraceView, isConsoleCaptureValue } from './StackTraceView';

/** Millisecond timestamp → Loki nanosecond string (string concat avoids float precision loss). */
function msToNs(ms: number): string {
  return `${Math.floor(ms)}000000`;
}

interface ExceptionDrawerProps {
  /**
   * Upstream Alloy hashes to load occurrences for. One entry for legacy
   * exceptionHash links; several when a fingerprint group (#62) merged
   * multiple raw hashes.
   */
  hashes: string[];
  /** Group title from the fingerprint pipeline (falls back to parsed value). */
  title?: string;
  service: string;
  namespace: string;
  environment?: string;
  logsUid: string;
  selectedSessionId: string;
  onSessionChange: (id: string) => void;
  onClose: () => void;
}

interface ParsedException {
  timestamp?: string;
  type?: string;
  value?: string;
  stacktrace?: string;
  browserName?: string;
  browserVersion?: string;
  browserOs?: string;
  pageUrl?: string;
  pageId?: string;
  appName?: string;
  appNamespace?: string;
  appVersion?: string;
  appEnvironment?: string;
  sessionId?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
}

interface Breadcrumb {
  timestampNs: string;
  kind: string;
  message: string;
  type?: string;
  value?: string;
  eventName?: string;
  eventDomain?: string;
  level?: string;
  fcp?: string;
  lcp?: string;
  cls?: string;
  inp?: string;
  ttfb?: string;
  rating?: string;
  attributes?: Record<string, string>;
}

interface GroupedBreadcrumb {
  timestampNs: string;
  kind: string;
  message: string;
  count: number;
}

interface AggregatedStats {
  uniqueUsers: number;
  uniqueSessions: number;
  appVersions: string[];
  browsers: string[];
  total: number;
}

export function ExceptionDrawer({
  hashes,
  title,
  service,
  namespace,
  environment,
  logsUid,
  selectedSessionId,
  onSessionChange,
  onClose,
}: ExceptionDrawerProps) {
  const styles = useStyles2(getStyles);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exception, setException] = useState<ParsedException | null>(null);
  const [stats, setStats] = useState<AggregatedStats | null>(null);
  const [occurrences, setOccurrences] = useState<ParsedException[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<GroupedBreadcrumb[]>([]);
  const [loadingBreadcrumbs, setLoadingBreadcrumbs] = useState(false);
  const labelOverrides = usePluginLabelOverrides();

  const fl = otel.faroLoki;
  const clusterLabel = labelOverrides.deploymentEnvLabel || otel.labels.deploymentEnv;
  const clusterStream = environment ? `, ${clusterLabel}="${sanitizeLabelValue(environment)}"` : '';
  const { fromMs, toMs } = useTimeRange();

  const selectedSessionIdRef = useRef(selectedSessionId);
  const onSessionChangeRef = useRef(onSessionChange);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
    onSessionChangeRef.current = onSessionChange;
  }, [selectedSessionId, onSessionChange]);

  // Stable key so the occurrences effect doesn't refire on array identity.
  const hashesKey = hashes.map(sanitizeLabelValue).join('|');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Line prefilters let Loki skip logfmt-parsing lines for other hashes.
    // Multiple hashes = one fingerprint group's members (#62).
    const single = !hashesKey.includes('|');
    const lineFilter = single ? `|= \`${fl.hash}=${hashesKey}\`` : `|~ \`${fl.hash}=(${hashesKey})\``;
    const fieldFilter = single ? `${fl.hash}="${hashesKey}"` : `${fl.hash}=~"(${hashesKey})"`;
    const query = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"${clusterStream}} ${lineFilter} | logfmt | ${fieldFilter}`;

    lastValueFrom(
      getBackendSrv().fetch<any>({
        url: `/api/datasources/proxy/uid/${encodeURIComponent(logsUid)}/loki/api/v1/query_range`,
        params: {
          query,
          limit: '100', // Fetch up to 100 instances to aggregate impact
          start: msToNs(fromMs),
          end: msToNs(toMs),
        },
        method: 'GET',
      })
    )
      .then((res) => {
        if (cancelled) {
          return;
        }

        const streams = res.data?.data?.result ?? [];
        if (streams.length === 0 || !streams[0].values || streams[0].values.length === 0) {
          setError('No details found in Loki for this exception hash.');
          setLoading(false);
          return;
        }

        const uniqueSessionsMap = new Map<string, ParsedException>();
        let total = 0;
        const users = new Set<string>();
        const sessions = new Set<string>();
        const versions = new Set<string>();
        const browsers = new Set<string>();

        // Aggregate across all returned streams (Loki might return multiple streams if labels differ)
        streams.forEach((stream: any) => {
          stream.values.forEach((val: [string, string]) => {
            total++;
            const parsed = parseLogfmt(val[1]);
            const ex: ParsedException = {
              timestamp: parsed.timestamp,
              type: parsed.type,
              value: parsed.value,
              stacktrace: parsed.stacktrace?.replace(/\\n/g, '\n'),
              browserName: parsed.browser_name,
              browserVersion: parsed.browser_version,
              browserOs: parsed.browser_os,
              pageUrl: parsed.page_url,
              pageId: parsed.page_id,
              appName: parsed.app_name,
              appVersion: parsed.app_version,
              appEnvironment: parsed.app_environment,
              appNamespace: parsed.app_namespace,
              sessionId: parsed.session_id,
              userId: parsed.user_id,
              userName: parsed.user_username,
              userEmail: parsed.user_email,
            };

            if (ex.sessionId && !uniqueSessionsMap.has(ex.sessionId)) {
              uniqueSessionsMap.set(ex.sessionId, ex);
            }

            const user = parsed.user_email || parsed.user_username || parsed.user_id;
            if (user) {
              users.add(user);
            }
            if (parsed.session_id) {
              sessions.add(parsed.session_id);
            }
            if (parsed.app_version) {
              versions.add(parsed.app_version);
            }
            if (parsed.browser_name) {
              const b = `${parsed.browser_name} ${parsed.browser_version || ''}`.trim();
              browsers.add(b);
            }
          });
        });

        setStats({
          uniqueUsers: users.size,
          uniqueSessions: sessions.size,
          appVersions: Array.from(versions),
          browsers: Array.from(browsers),
          total,
        });

        const sessionList = Array.from(uniqueSessionsMap.values());
        setOccurrences(sessionList);

        if (sessionList.length > 0) {
          const matched = selectedSessionIdRef.current
            ? sessionList.find((s) => s.sessionId === selectedSessionIdRef.current)
            : null;
          const defaultSession = matched || sessionList[0];
          setException(defaultSession);
          if (defaultSession.sessionId && defaultSession.sessionId !== selectedSessionIdRef.current) {
            onSessionChangeRef.current(defaultSession.sessionId);
          }
        }

        setLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.message || 'Failed to fetch exception details from Loki.');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    hashesKey,
    service,
    environment,
    logsUid,
    labelOverrides,
    clusterStream,
    fromMs,
    toMs,
    fl.hash,
    fl.kind,
    fl.kindException,
    fl.serviceName,
  ]);

  // Fetch breadcrumbs whenever the selected session ID changes
  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }
    let cancelled = false;
    setLoadingBreadcrumbs(true);

    // The |= line filter lets Loki skip logfmt-parsing every Faro line for the app.
    const breadcrumbsQuery = `{${fl.serviceName}="${sanitizeLabelValue(service)}"${clusterStream}} |= \`${fl.sessionId}=${sanitizeLabelValue(selectedSessionId)}\` | logfmt | ${fl.sessionId}="${sanitizeLabelValue(selectedSessionId)}"`;

    // Pad the page range by an hour on both sides so a session that started
    // before (or ended after) the selected range isn't clipped.
    const padMs = 3600_000;

    lastValueFrom(
      getBackendSrv().fetch<any>({
        url: `/api/datasources/proxy/uid/${encodeURIComponent(logsUid)}/loki/api/v1/query_range`,
        params: {
          query: breadcrumbsQuery,
          limit: '20',
          direction: 'backward', // get the most recent 20 events for the session
          start: msToNs(fromMs - padMs),
          end: msToNs(toMs + padMs),
        },
        method: 'GET',
      })
    )
      .then((bcRes) => {
        if (cancelled) {
          return;
        }
        const bcStreams = bcRes.data?.data?.result ?? [];
        const crumbs: Breadcrumb[] = [];
        bcStreams.forEach((stream: any) => {
          stream.values.forEach((val: [string, string]) => {
            const ts = val[0];
            const p = parseLogfmt(val[1]);

            const attrs: Record<string, string> = {};
            Object.keys(p).forEach((key) => {
              if (key.startsWith('event_data_')) {
                const cleanKey = key.slice('event_data_'.length);
                attrs[cleanKey] = p[key];
              } else if (key.startsWith('event_attribute_')) {
                const cleanKey = key.slice('event_attribute_'.length);
                attrs[cleanKey] = p[key];
              } else if (key.startsWith('event_attributes_')) {
                const cleanKey = key.slice('event_attributes_'.length);
                attrs[cleanKey] = p[key];
              }
            });

            crumbs.push({
              timestampNs: ts,
              kind: p.kind || p.level || 'unknown',
              message: p.message || p.value || '',
              type: p.type,
              value: p.value,
              eventName: p.event_name,
              eventDomain: p.event_domain,
              level: p.level,
              fcp: p.fcp,
              lcp: p.lcp,
              cls: p.cls,
              inp: p.inp,
              ttfb: p.ttfb,
              rating: p.context_rating,
              attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
            });
          });
        });
        // Sort chronologically (oldest first)
        crumbs.sort((a, b) => (a.timestampNs > b.timestampNs ? 1 : -1));

        // Group consecutive duplicates
        const groupedCrumbs: GroupedBreadcrumb[] = [];
        crumbs.forEach((crumb) => {
          const msg = getBreadcrumbMessage(crumb);
          const last = groupedCrumbs[groupedCrumbs.length - 1];
          if (last && last.kind === crumb.kind && last.message === msg) {
            last.count++;
          } else {
            groupedCrumbs.push({
              timestampNs: crumb.timestampNs,
              kind: crumb.kind,
              message: msg,
              count: 1,
            });
          }
        });

        setBreadcrumbs(groupedCrumbs);
        setLoadingBreadcrumbs(false);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadingBreadcrumbs(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, service, environment, logsUid, clusterStream, fromMs, toMs, fl.serviceName, fl.sessionId]);

  useEffect(() => {
    if (occurrences.length > 0 && selectedSessionId) {
      const matched = occurrences.find((o) => o.sessionId === selectedSessionId);
      if (matched) {
        setException(matched);
      }
    }
  }, [selectedSessionId, occurrences]);

  const handleSessionChange = (sessionId: string) => {
    onSessionChange(sessionId);
    const matched = occurrences.find((o) => o.sessionId === sessionId);
    if (matched) {
      setException(matched);
    }
  };

  const envParam = environment ? `&environment=${encodeURIComponent(environment)}` : '';
  const nsSegment = encodeURIComponent(namespace || '_');

  // Logs search takes one term — use the session when known, else the first
  // member hash (merged groups: searching a single member is still useful).
  const logsUrl = exception?.sessionId
    ? `${PLUGIN_BASE_URL}/services/${nsSegment}/${encodeURIComponent(service)}?tab=logs&from=now-6h&to=now${envParam}&includeFaro=true&logSearch=${encodeURIComponent(exception.sessionId)}`
    : `${PLUGIN_BASE_URL}/services/${nsSegment}/${encodeURIComponent(service)}?tab=logs&from=now-6h&to=now${envParam}&includeFaro=true&kindFilter=exception&logSearch=${encodeURIComponent(hashes[0] ?? '')}`;

  return (
    <Drawer
      title={exception?.type || 'Exception Details'}
      subtitle={title || exception?.value || hashes[0]}
      onClose={onClose}
      closeOnMaskClick={true}
      size="lg"
    >
      <div className={styles.container}>
        {loading && (
          <div className={styles.center}>
            <Spinner size="lg" />
            <span className={styles.loadingText}>Fetching exception details...</span>
          </div>
        )}

        {error && (
          <Alert severity="error" title="Error fetching details">
            {error}
          </Alert>
        )}

        {exception && (
          <>
            {stats && (
              <div className={styles.section}>
                <h4 className={styles.sectionTitle}>Context & Impact (Last {stats.total} occurrences)</h4>
                <div className={styles.contextImpactContainer}>
                  <div className={styles.contextColumn}>
                    <h5 className={styles.subSectionTitle}>Most Recent Occurrence</h5>
                    <div className={styles.metaList}>
                      <MetaItem
                        label="Browser"
                        value={
                          exception.browserName
                            ? `${exception.browserName} ${exception.browserVersion ?? ''}`
                            : undefined
                        }
                        icon="monitor"
                      />
                      <MetaItem label="OS" value={exception.browserOs} icon="desktop" />
                      <MetaItem
                        label="URL"
                        value={cleanUrl(exception.pageUrl)}
                        link={cleanUrl(exception.pageUrl)}
                        icon="link"
                      />
                      <MetaItem label="Page ID / Route" value={exception.pageId} icon="compass" />
                      <MetaItem
                        label="App instance"
                        value={
                          exception.appName
                            ? `${exception.appName}${exception.appVersion ? ` @ ${exception.appVersion}` : ''}`
                            : undefined
                        }
                        icon="cube"
                      />
                      <MetaItem label="Environment" value={exception.appEnvironment} icon="cloud" />
                      <MetaItem
                        label="User"
                        value={exception.userEmail || exception.userName || exception.userId || 'Anonymous'}
                        icon="users-alt"
                      />
                      {occurrences.length > 1 ? (
                        <div className={styles.metaItem} style={{ alignItems: 'center' }}>
                          <span
                            className={styles.metaLabel}
                            style={{ display: 'inline-flex', alignItems: 'center', height: '32px' }}
                          >
                            <Icon name="user" className={styles.metaIcon} /> Session ID:
                          </span>
                          <span className={styles.metaValue} style={{ width: '220px' }}>
                            <Combobox<string>
                              options={occurrences.map((occ) => {
                                const browserStr = occ.browserName
                                  ? `${occ.browserName} ${occ.browserVersion || ''}`.trim()
                                  : '';
                                const sysStr = occ.browserOs ? `on ${occ.browserOs}` : '';
                                return {
                                  label: `${occ.sessionId?.slice(0, 8)}... (${occ.timestamp ? new Date(occ.timestamp).toLocaleTimeString() : 'unknown'})`,
                                  value: occ.sessionId || '',
                                  description: `${browserStr} ${sysStr}`.trim() || undefined,
                                };
                              })}
                              value={selectedSessionId}
                              onChange={(opt) => opt && handleSessionChange(opt.value || '')}
                            />
                          </span>
                        </div>
                      ) : (
                        <MetaItem label="Session ID" value={exception.sessionId} icon="user" />
                      )}
                      <MetaItem label="Timestamp" value={exception.timestamp} icon="clock-nine" />
                    </div>
                  </div>
                  <div className={styles.impactColumn}>
                    <h5 className={styles.subSectionTitle}>Aggregate Impact</h5>
                    <div className={styles.metaList}>
                      <MetaItem
                        label="Impacted Users"
                        value={stats.uniqueUsers > 0 ? `${stats.uniqueUsers} identified` : '0 (Anonymous)'}
                        icon="users-alt"
                      />
                      <MetaItem
                        label="Unique Sessions"
                        value={stats.uniqueSessions ? `${stats.uniqueSessions} sessions` : '0'}
                        icon="user"
                      />
                      <MetaItem label="App Versions" value={formatListWithMore(stats.appVersions, 4)} icon="cube" />
                      <MetaItem label="Browsers" value={formatListWithMore(stats.browsers, 4)} icon="monitor" />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {exception.stacktrace && (
              <div className={styles.section}>
                <h4 className={styles.sectionTitle}>
                  Stack Trace
                  {isConsoleCaptureValue(exception.value) && (
                    <Tooltip content="This exception was captured via console.error — the stack shows the call site of console.error (often a shared logger), not where the error was thrown. The first in-app frame below is the best origin guess.">
                      <Badge
                        className={styles.captureBadge}
                        text="Captured via console.error"
                        color="orange"
                        icon="exclamation-triangle"
                      />
                    </Tooltip>
                  )}
                </h4>
                <StackTraceView
                  stack={exception.stacktrace}
                  isConsoleCapture={isConsoleCaptureValue(exception.value)}
                  className={styles.stacktrace}
                />
              </div>
            )}

            {exception.sessionId && (
              <div className={styles.section}>
                <h4 className={styles.sectionTitle}>Session Timeline (Breadcrumbs)</h4>
                {loadingBreadcrumbs ? (
                  <div className={styles.bcLoading}>
                    <Spinner inline /> Loading breadcrumbs...
                  </div>
                ) : breadcrumbs.length > 0 ? (
                  <div className={styles.breadcrumbs}>
                    {breadcrumbs.map((bc, idx) => (
                      <div key={idx} className={styles.breadcrumbItem}>
                        <span className={styles.bcTime}>{formatTimestampNs(bc.timestampNs)}</span>
                        <span className={styles.bcKind(bc.kind)}>
                          <Icon name={getBreadcrumbIcon(bc.kind) as any} size="sm" style={{ marginRight: '4px' }} />
                          {bc.kind}
                        </span>
                        <span className={styles.bcMessage}>
                          {bc.message}
                          {bc.count > 1 && <span className={styles.bcCount}> ({bc.count}x)</span>}
                        </span>
                      </div>
                    ))}
                    <div className={styles.bcFooter}>
                      Showing last {breadcrumbs.length} events.{' '}
                      <a href={logsUrl} target="_blank" rel="noopener noreferrer">
                        View full session in Logs
                      </a>
                    </div>
                  </div>
                ) : (
                  <span style={{ color: '#8c95a5', fontSize: '12px' }}>No session events found.</span>
                )}
              </div>
            )}

            <div className={styles.footerLinks}>
              {exception.sessionId && (
                <>
                  <a href={logsUrl} target="_blank" rel="noopener noreferrer" className={styles.footerLink}>
                    <Icon name="history" /> View Full Session Timeline in Logs
                  </a>
                  <span className={styles.footerDivider}>|</span>
                </>
              )}
              <a
                href={`${PLUGIN_BASE_URL}/services/${nsSegment}/${encodeURIComponent(service)}?tab=logs&from=now-6h&to=now${envParam}&includeFaro=true&kindFilter=exception&logSearch=${encodeURIComponent(hashes[0] ?? '')}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.footerLink}
              >
                <Icon name="file-alt" /> View Raw Loki Log
              </a>
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}

function MetaItem({ label, value, link, icon }: { label: string; value?: string; link?: string; icon: string }) {
  const styles = useStyles2(getStyles);
  if (!value) {
    return null;
  }
  return (
    <div className={styles.metaItem}>
      <span className={styles.metaLabel}>
        <Icon name={icon as any} className={styles.metaIcon} /> {label}:
      </span>
      <span className={styles.metaValue}>
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer" className={styles.metaLink}>
            {value}
          </a>
        ) : (
          value
        )}
      </span>
    </div>
  );
}

function parseLogfmt(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^\s]+))/g;
  let match;
  while ((match = regex.exec(line)) !== null) {
    const key = match[1];
    const val = match[2] !== undefined ? match[2] : match[3];
    result[key] = val;
  }
  return result;
}

function getBreadcrumbMessage(bc: Breadcrumb): string {
  if (bc.kind === 'event') {
    const name = bc.eventName ? `${bc.eventDomain ? bc.eventDomain + '/' : ''}${bc.eventName}` : 'Unknown Event';

    if (bc.eventName === 'faro.performance.resource' && bc.attributes) {
      const resUrl = bc.attributes.name || '';
      const cleanUrl = resUrl.split('?')[0];
      const duration = bc.attributes.duration ? `${parseInt(bc.attributes.duration, 10)}ms` : '';
      const initiator = bc.attributes.initiatorType || '';
      const cache = bc.attributes.cacheHitStatus || '';
      let sizeStr = '';
      if (bc.attributes.transferSize) {
        const bytes = parseInt(bc.attributes.transferSize, 10);
        if (bytes > 0) {
          sizeStr = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
        }
      }
      const details = [initiator, duration, sizeStr, cache].filter(Boolean).join(', ');
      return `resource: ${cleanUrl}${details ? ` [${details}]` : ''}`;
    }

    if (bc.eventName === 'faro.performance.navigation' && bc.attributes) {
      const pageUrl = bc.attributes.name || '';
      const cleanUrl = pageUrl.split('?')[0];
      const duration = bc.attributes.duration ? `${parseInt(bc.attributes.duration, 10)}ms` : '';
      return `navigation: ${cleanUrl}${duration ? ` [${duration}]` : ''}`;
    }

    if (bc.attributes) {
      const attrStr = Object.entries(bc.attributes)
        .map(([k, v]) => `${k}="${v}"`)
        .join(', ');
      return `${name} {${attrStr}}`;
    }
    return name;
  }
  if (bc.kind === 'measurement' && bc.type === 'web-vitals') {
    const vitals = [];
    if (bc.fcp) {
      vitals.push(`FCP=${parseFloat(bc.fcp).toFixed(0)}ms`);
    }
    if (bc.lcp) {
      vitals.push(`LCP=${parseFloat(bc.lcp).toFixed(0)}ms`);
    }
    if (bc.cls) {
      vitals.push(`CLS=${parseFloat(bc.cls).toFixed(3)}`);
    }
    if (bc.inp) {
      vitals.push(`INP=${parseFloat(bc.inp).toFixed(0)}ms`);
    }
    if (bc.ttfb) {
      vitals.push(`TTFB=${parseFloat(bc.ttfb).toFixed(0)}ms`);
    }
    const val = vitals.length > 0 ? vitals.join(', ') : 'Empty Measurement';
    return bc.rating ? `${val} [${bc.rating}]` : val;
  }
  if (bc.kind === 'exception' || bc.level === 'error') {
    return bc.message || bc.value || bc.type || 'Error';
  }
  return bc.message || bc.value || bc.type || '';
}

function getBreadcrumbIcon(kind: string): string {
  if (kind === 'event') {
    return 'bolt';
  }
  if (kind === 'measurement') {
    return 'chart-line';
  }
  if (kind === 'exception' || kind === 'error') {
    return 'exclamation-triangle';
  }
  return 'file-alt';
}

function formatTimestampNs(tsNs: string): string {
  const tsMs = Math.floor(parseInt(tsNs, 10) / 1000000);
  const d = new Date(tsMs);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}

function formatListWithMore(items: string[], max = 2): string {
  if (items.length === 0) {
    return 'N/A';
  }
  if (items.length <= max) {
    return items.join(', ');
  }
  return `${items.slice(0, max).join(', ')} (+${items.length - max} more)`;
}

function cleanUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  return url.endsWith('.') ? url.slice(0, -1) : url;
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(3)};
  `,
  center: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: ${theme.spacing(5)};
    gap: ${theme.spacing(2)};
  `,
  loadingText: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  actions: css`
    display: flex;
    gap: ${theme.spacing(2)};
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1.5)};
  `,
  sectionTitle: css`
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    margin: 0;
    border-bottom: 1px solid ${theme.colors.border.weak};
    padding-bottom: ${theme.spacing(0.75)};
    color: ${theme.colors.text.primary};
  `,
  metadataGrid: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: ${theme.spacing(1.5)};
    @media (max-width: 800px) {
      grid-template-columns: 1fr;
    }
  `,
  metaList: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  metaItem: css`
    display: flex;
    gap: ${theme.spacing(1)};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  metaLabel: css`
    color: ${theme.colors.text.secondary};
    font-weight: ${theme.typography.fontWeightMedium};
    white-space: nowrap;
  `,
  metaIcon: css`
    margin-right: 4px;
  `,
  metaValue: css`
    color: ${theme.colors.text.primary};
    word-break: break-all;
  `,
  metaLink: css`
    color: ${theme.colors.text.link};
    text-decoration: underline;
  `,
  contextImpactContainer: css`
    display: flex;
    flex-direction: row;
    gap: ${theme.spacing(3)};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
    @media (max-width: 900px) {
      flex-direction: column;
    }
  `,
  contextColumn: css`
    flex: 1.2;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1.5)};
  `,
  impactColumn: css`
    flex: 0.8;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1.5)};
    border-left: 1px solid ${theme.colors.border.weak};
    padding-left: ${theme.spacing(3)};
    @media (max-width: 900px) {
      border-left: none;
      padding-left: 0;
      border-top: 1px solid ${theme.colors.border.weak};
      padding-top: ${theme.spacing(2)};
    }
  `,
  subSectionTitle: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightBold};
    color: ${theme.colors.text.secondary};
    margin: 0 0 ${theme.spacing(0.5)} 0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  `,
  captureBadge: css`
    margin-left: ${theme.spacing(1)};
    vertical-align: middle;
  `,
  stacktrace: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    overflow-x: auto;
    white-space: pre-wrap;
    line-height: 1.6;
  `,
  bcLoading: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    display: flex;
    align-items: center;
    gap: 8px;
  `,
  breadcrumbs: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  breadcrumbItem: css`
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 2px 4px;
    border-bottom: 1px solid ${theme.colors.border.weak};
    &:last-child {
      border-bottom: none;
    }
  `,
  bcTime: css`
    color: ${theme.colors.text.secondary};
    font-size: 11px;
    min-width: 85px;
  `,
  bcKind: (kind: string) => css`
    font-size: 10px;
    text-transform: uppercase;
    font-weight: bold;
    padding: 2px 6px;
    border-radius: 4px;
    background: ${kind === 'exception' || kind === 'error'
      ? theme.colors.error.transparent
      : kind === 'measurement'
        ? theme.colors.warning.transparent
        : kind === 'event'
          ? theme.colors.success.transparent
          : theme.colors.primary.transparent};
    color: ${kind === 'exception' || kind === 'error'
      ? theme.colors.error.text
      : kind === 'measurement'
        ? theme.colors.warning.text
        : kind === 'event'
          ? theme.colors.success.text
          : theme.colors.primary.text};
    min-width: 90px;
    text-align: left;
    display: flex;
    align-items: center;
  `,
  bcMessage: css`
    color: ${theme.colors.text.primary};
    word-break: break-all;
    white-space: pre-wrap;
  `,
  bcCount: css`
    color: ${theme.colors.text.secondary};
    font-weight: ${theme.typography.fontWeightBold};
    font-size: 11px;
    margin-left: 4px;
  `,
  bcFooter: css`
    padding-top: 8px;
    margin-top: 4px;
    text-align: center;
    color: ${theme.colors.text.secondary};
    font-size: 11px;
    border-top: 1px dashed ${theme.colors.border.weak};
    a {
      color: ${theme.colors.text.link};
      text-decoration: underline;
    }
  `,
  footerLinks: css`
    display: flex;
    justify-content: center;
    align-items: center;
    gap: ${theme.spacing(2)};
    padding-top: ${theme.spacing(2)};
    border-top: 1px solid ${theme.colors.border.weak};
    margin-top: ${theme.spacing(1)};
  `,
  footerLink: css`
    color: ${theme.colors.text.link};
    text-decoration: underline;
    font-size: ${theme.typography.bodySmall.fontSize};
    display: flex;
    align-items: center;
    gap: 6px;
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
  footerDivider: css`
    color: ${theme.colors.border.weak};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
