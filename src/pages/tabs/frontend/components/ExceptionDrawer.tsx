import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  Drawer,
  Icon,
  Input,
  Spinner,
  Alert,
  useStyles2,
  Combobox,
  Badge,
  Tooltip,
  ControlledCollapse,
  TextLink,
} from '@grafana/ui';
import { AppEvents, GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getAppEvents, getBackendSrv, locationService } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import {
  getAlertTemplate,
  buildAlertRuleUrl,
  getTriageStates,
  postTriageAction,
  getFeedback,
  getSourcemapDoctor,
  IssueSource,
  TriageState,
  FeedbackEntry,
  SourcemapDoctorResult,
} from '../../../../api/client';
import { otel } from '../../../../otelconfig';
import { PLUGIN_BASE_URL } from '../../../../constants';
import { sanitizeLabelValue } from '../../../../utils/sanitize';
import { apmDocs, frontendDocs } from '../../../../utils/docsLinks';
import { usePluginLabelOverrides, usePluginDatasources } from '../../../../utils/datasources';
import { useTimeRange } from '../../../../utils/timeRange';
import { buildExceptionTracesExploreUrl } from '../../../../utils/explore';
import { StackTraceView, isConsoleCaptureValue } from './StackTraceView';
import { stackLooksMinified, firstScriptUrl } from '../frames';
import { useIssueOccurrences, msToNs, ParsedException } from '../useIssueOccurrences';
import {
  parseLogfmt,
  getBreadcrumbIcon,
  groupBreadcrumbs,
  formatTimestampNs,
  formatListWithMore,
  cleanUrl,
  Breadcrumb,
  GroupedBreadcrumb,
} from '../exception-utils';
import { probeReplay, ReplayProbeResult } from '../replay/fetchReplay';
import { ReplaySection } from '../replay/ReplaySection';

/**
 * Pad session-scoped queries (breadcrumbs, replay chunks) by an hour on both
 * sides so a session that started before (or ended after) the selected page
 * range isn't clipped.
 */
const SESSION_PAD_MS = 3600_000;

/** Compact "Xm/Xh/Xd ago" label for the impact strip and feedback list. */
function formatRelativeTime(ms: number): string {
  const diffMs = Date.now() - ms;
  if (diffMs < 60_000) {
    return 'just now';
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo ago`;
  }
  return `${Math.floor(months / 12)}y ago`;
}

interface ExceptionDrawerProps {
  /**
   * Upstream Alloy hashes to load occurrences for (browser issues). One entry
   * for legacy exceptionHash links; several when a fingerprint group (#62)
   * merged multiple raw hashes. Empty for server issues (they have no hash).
   */
  hashes: string[];
  /**
   * Telemetry source: 'browser' (hash→Loki, the default) or 'server' (backend
   * occurrences endpoint, #84). Determines the data path and which
   * source-specific sections render.
   */
  source?: IssueSource;
  /**
   * True while a fresh `issueId` deep link is still resolving. The drawer
   * mounts immediately (so the open animation plays once) and shows its
   * spinner; the occurrence fetch is skipped until the issue resolves.
   */
  resolving?: boolean;
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

export function ExceptionDrawer({
  hashes,
  source = 'browser',
  resolving = false,
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
  const [breadcrumbs, setBreadcrumbs] = useState<GroupedBreadcrumb[]>([]);
  const [loadingBreadcrumbs, setLoadingBreadcrumbs] = useState(false);
  const [replayProbe, setReplayProbe] = useState<ReplayProbeResult | null>(null);
  const [creatingAlert, setCreatingAlert] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  // Minified-stack hint + source-map doctor (#60).
  const [minifiedDismissed, setMinifiedDismissed] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<SourcemapDoctorResult | null>(null);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);
  // Server occurrences are picked by list index (no session identity).
  const [serverIndex, setServerIndex] = useState(0);
  const labelOverrides = usePluginLabelOverrides();
  const ds = usePluginDatasources(environment || undefined);
  // The drawer is opened purely from URL state (docs/url-contract.md) — the
  // fingerprint identity lives in the `issueId` search param, not in props.
  const [searchParams] = useSearchParams();
  const issueId = searchParams.get('issueId') ?? '';
  const isServer = source === 'server';

  const fl = otel.faroLoki;
  const clusterLabel = labelOverrides.deploymentEnvLabel || otel.labels.deploymentEnv;
  const clusterStream = environment ? `, ${clusterLabel}="${sanitizeLabelValue(environment)}"` : '';
  const { fromMs, toMs } = useTimeRange();

  // The two data paths (browser hash→Loki, server occurrences endpoint) are
  // abstracted behind this one hook; both resolve to occurrences + stats (#84).
  const { loading, error, occurrences, stats } = useIssueOccurrences({
    source,
    hashes,
    issueId,
    service,
    namespace,
    environment,
    logsUid,
    fromMs,
    toMs,
    resolving,
  });

  // Browser: selection follows the session URL param (falling back to the most
  // recent). Server: selection is the picked list index (most recent default).
  const browserException = isServer
    ? null
    : ((selectedSessionId ? occurrences.find((o) => o.sessionId === selectedSessionId) : undefined) ??
      occurrences[0] ??
      null);
  const exception: ParsedException | null = isServer
    ? (occurrences[serverIndex] ?? occurrences[0] ?? null)
    : browserException;

  // Default the session param to the most recent occurrence once loaded, so the
  // session-scoped sections (timeline, replay) have a session to key on.
  useEffect(() => {
    if (isServer || occurrences.length === 0) {
      return;
    }
    const matched = selectedSessionId && occurrences.some((o) => o.sessionId === selectedSessionId);
    if (!matched) {
      const first = occurrences[0];
      if (first.sessionId && first.sessionId !== selectedSessionId) {
        onSessionChange(first.sessionId);
      }
    }
    // Only re-run when the occurrence set changes; onSessionChange is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isServer, occurrences]);

  // Reset the server picker when a new issue's occurrences load.
  useEffect(() => {
    setServerIndex(0);
  }, [issueId, occurrences.length]);

  // Fetch breadcrumbs whenever the selected session ID changes
  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }
    let cancelled = false;
    setLoadingBreadcrumbs(true);

    // The |= line filter lets Loki skip logfmt-parsing every Faro line for the app.
    const breadcrumbsQuery = `{${fl.serviceName}="${sanitizeLabelValue(service)}"${clusterStream}} |= \`${fl.sessionId}=${sanitizeLabelValue(selectedSessionId)}\` | logfmt | ${fl.sessionId}="${sanitizeLabelValue(selectedSessionId)}"`;

    const padMs = SESSION_PAD_MS;

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
        setBreadcrumbs(groupBreadcrumbs(crumbs));
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

  // Probe for session-replay chunks (#58/#67) whenever the session changes —
  // a cheap count-only metric query; the chunks themselves are only fetched
  // when the user clicks the replay button.
  useEffect(() => {
    setReplayProbe(null);
    if (!selectedSessionId) {
      return;
    }
    let cancelled = false;
    probeReplay({
      logsUid,
      service,
      sessionId: selectedSessionId,
      fromMs: fromMs - SESSION_PAD_MS,
      toMs: toMs + SESSION_PAD_MS,
      environment,
      environmentLabel: clusterLabel,
    })
      .then((probe) => {
        if (!cancelled) {
          setReplayProbe(probe);
        }
      })
      .catch(() => {
        // No replay section on probe failure — replay is best-effort.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, service, environment, logsUid, clusterLabel, fromMs, toMs]);

  // User feedback (M6): scoped to this issue's fingerprint, not the selected
  // session — feedback is rare, so we show everything tied to the issue
  // rather than narrowing to whichever occurrence happens to be selected.
  // No fingerprint (legacy exceptionHash-only links) means no reliable join
  // key, so skip the fetch entirely rather than showing unrelated feedback.
  useEffect(() => {
    // Feedback is browser-captured (@nais/apm) and joined by fingerprint;
    // server feedback is deferred (#84), so skip the fetch for server issues.
    if (!issueId || isServer) {
      setFeedback([]);
      return;
    }
    let cancelled = false;
    getFeedback(namespace, service, fromMs, toMs, environment, undefined, issueId)
      .then((res) => {
        if (!cancelled) {
          setFeedback(res.unavailable ? [] : (res.feedback ?? []));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFeedback([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [issueId, isServer, namespace, service, environment, fromMs, toMs]);

  const handleSessionChange = (sessionId: string) => {
    onSessionChange(sessionId);
  };

  // "Create alert" (#65): fetch the server-rendered exception-spike template
  // and open Grafana's new-alert-rule form pre-filled for this issue.
  const onCreateAlert = async () => {
    setCreatingAlert(true);
    try {
      const template = await getAlertTemplate('exception-spike', {
        namespace: namespace || undefined,
        service,
        environment,
        fingerprint: issueId || undefined,
        hashes,
      });
      locationService.push(buildAlertRuleUrl(template.url));
    } catch (err) {
      setCreatingAlert(false);
      getAppEvents().publish({
        type: AppEvents.alertError.name,
        payload: ['Could not prepare alert rule', err instanceof Error ? err.message : String(err)],
      });
    }
  };

  const envParam = environment ? `&environment=${encodeURIComponent(environment)}` : '';
  const nsSegment = encodeURIComponent(namespace || '_');

  // Absolute exception time (ms) when derivable — recordings seek to it minus 10s.
  const parsedExceptionTs = exception?.timestamp ? Date.parse(exception.timestamp) : NaN;
  const exceptionTsMs = Number.isFinite(parsedExceptionTs) ? parsedExceptionTs : undefined;

  // Logs search takes one term — use the session when known, else the first
  // member hash (merged groups: searching a single member is still useful).
  const logsUrl = exception?.sessionId
    ? `${PLUGIN_BASE_URL}/services/${nsSegment}/${encodeURIComponent(service)}?tab=logs&from=now-6h&to=now${envParam}&includeFaro=true&logSearch=${encodeURIComponent(exception.sessionId)}`
    : `${PLUGIN_BASE_URL}/services/${nsSegment}/${encodeURIComponent(service)}?tab=logs&from=now-6h&to=now${envParam}&includeFaro=true&kindFilter=exception&logSearch=${encodeURIComponent(hashes[0] ?? '')}`;

  // Server issues have no session or Alloy hash: deep-link the raw backend logs
  // by the error message (kind="" streams, no Faro), and — where Tempo ≥ 2.6 is
  // available — the traces carrying this exception type (#84).
  const serverLogSearch = (exception?.value ?? title ?? '').slice(0, 60);
  const serverLogsUrl = `${PLUGIN_BASE_URL}/services/${nsSegment}/${encodeURIComponent(service)}?tab=logs&from=now-6h&to=now${envParam}&logSearch=${encodeURIComponent(serverLogSearch)}`;
  const serverTracesUrl =
    isServer && ds.tracesUid
      ? buildExceptionTracesExploreUrl(ds.tracesUid, service, {
          exceptionType: exception?.type || undefined,
          from: 'now-6h',
          to: 'now',
        })
      : undefined;

  // Minified-stack detection (#60): a heuristic over the rendered stack, plus
  // the candidate bundle URL the source-map doctor can probe. Both memoized on
  // the stack string so they don't recompute on every unrelated re-render.
  const stacktrace = exception?.stacktrace;
  const looksMinified = useMemo(() => (stacktrace ? stackLooksMinified(stacktrace) : false), [stacktrace]);
  const scriptUrl = useMemo(() => (stacktrace ? firstScriptUrl(stacktrace) : undefined), [stacktrace]);

  // Reset the doctor + dismissal when the shown stack changes.
  useEffect(() => {
    setMinifiedDismissed(false);
    setDiagnosis(null);
    setDiagnosisError(null);
    setDiagnosing(false);
  }, [stacktrace]);

  const runDiagnosis = async () => {
    if (!scriptUrl) {
      return;
    }
    setDiagnosing(true);
    setDiagnosisError(null);
    try {
      setDiagnosis(await getSourcemapDoctor(namespace, service, scriptUrl));
    } catch (err) {
      setDiagnosisError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiagnosing(false);
    }
  };

  return (
    <Drawer
      title={exception?.type || 'Exception Details'}
      subtitle={title || exception?.value || hashes[0] || ''}
      onClose={onClose}
      closeOnMaskClick={true}
      size="lg"
    >
      <div className={styles.container}>
        {issueId && <TriageControls namespace={namespace} service={service} fingerprint={issueId} />}
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
            {/* P8 (docs/ia-review.md): stack trace leads — "where in my code?"
                is the developer's first question — with a one-line impact
                summary above it. Full context/breadcrumbs are collapsed by
                default so they don't push the stack trace below the fold. */}
            {stats && (
              <div className={styles.impactStrip}>
                <Icon name="fire" size="sm" />
                <span>
                  {stats.total} occurrence{stats.total === 1 ? '' : 's'}
                </span>
                <span className={styles.impactDivider}>·</span>
                {isServer ? (
                  <span>
                    {stats.pods ?? 0} pod{(stats.pods ?? 0) === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span>
                    {stats.uniqueSessions} session{stats.uniqueSessions === 1 ? '' : 's'}
                  </span>
                )}
                {stats.firstSeenMs !== undefined && (
                  <>
                    <span className={styles.impactDivider}>·</span>
                    <span>first seen {formatRelativeTime(stats.firstSeenMs)}</span>
                  </>
                )}
                {stats.lastSeenMs !== undefined && (
                  <>
                    <span className={styles.impactDivider}>·</span>
                    <span>last seen {formatRelativeTime(stats.lastSeenMs)}</span>
                  </>
                )}
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
                {looksMinified && !minifiedDismissed && (
                  <Alert severity="info" title="This stack looks minified" onRemove={() => setMinifiedDismissed(true)}>
                    <div className={styles.minifiedAlert}>
                      <span>
                        Source maps weren&rsquo;t resolved at ingest, so frames show mangled names and deep column
                        offsets. Fixing the ingest config only affects <strong>new</strong> exceptions — already-stored
                        stacks stay minified.
                      </span>
                      <div className={styles.minifiedActions}>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="sync"
                          disabled={diagnosing || !scriptUrl}
                          onClick={runDiagnosis}
                          tooltip={scriptUrl ? undefined : 'No cdn.nav.no bundle URL found in this stack'}
                        >
                          {diagnosing ? 'Running diagnosis…' : 'Run diagnosis'}
                        </Button>
                        <TextLink href={frontendDocs.sourcemaps()} external variant="bodySmall">
                          About source maps
                        </TextLink>
                      </div>
                      {diagnosisError && <span className={styles.minifiedError}>{diagnosisError}</span>}
                      {diagnosis && <SourcemapChecklist result={diagnosis} />}
                    </div>
                  </Alert>
                )}
                <StackTraceView
                  stack={exception.stacktrace}
                  isConsoleCapture={isConsoleCaptureValue(exception.value)}
                  className={styles.stacktrace}
                />
              </div>
            )}

            {stats && (
              <ControlledCollapse label={`Occurrence context (last ${stats.total} occurrences)`} isOpen={false}>
                <div className={styles.contextImpactContainer}>
                  <div className={styles.contextColumn}>
                    <h5 className={styles.subSectionTitle}>Most Recent Occurrence</h5>
                    <div className={styles.metaList}>
                      {isServer ? (
                        <>
                          <MetaItem label="Type" value={exception.type} icon="bug" />
                          <MetaItem label="Level" value={exception.level} icon="exclamation-triangle" />
                          <MetaItem label="App version" value={exception.appVersion} icon="cube" />
                          {occurrences.length > 1 ? (
                            <div className={styles.metaItem} style={{ alignItems: 'center' }}>
                              <span
                                className={styles.metaLabel}
                                style={{ display: 'inline-flex', alignItems: 'center', height: '32px' }}
                              >
                                <Icon name="cube" className={styles.metaIcon} /> Pod:
                              </span>
                              <span className={styles.metaValue} style={{ width: '220px' }}>
                                <Combobox<number>
                                  options={occurrences.map((occ, idx) => ({
                                    label: `${occ.pod || 'unknown pod'} (${occ.timestamp ? new Date(occ.timestamp).toLocaleTimeString() : 'unknown'})`,
                                    value: idx,
                                    description: occ.level || undefined,
                                  }))}
                                  value={serverIndex}
                                  onChange={(opt) => opt && setServerIndex(opt.value ?? 0)}
                                />
                              </span>
                            </div>
                          ) : (
                            <MetaItem label="Pod" value={exception.pod} icon="cube" />
                          )}
                          <MetaItem label="Timestamp" value={exception.timestamp} icon="clock-nine" />
                        </>
                      ) : (
                        <>
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
                        </>
                      )}
                    </div>
                  </div>
                  <div className={styles.impactColumn}>
                    <h5 className={styles.subSectionTitle}>Aggregate Impact</h5>
                    <div className={styles.metaList}>
                      {isServer ? (
                        <>
                          <MetaItem label="Occurrences" value={`${stats.total}`} icon="fire" />
                          <MetaItem label="Distinct Pods" value={stats.pods ? `${stats.pods} pods` : '0'} icon="cube" />
                          <MetaItem
                            label="App Versions"
                            value={formatListWithMore(stats.appVersions, 4) || undefined}
                            icon="cube"
                          />
                        </>
                      ) : (
                        <>
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
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </ControlledCollapse>
            )}

            {exception.sessionId && (
              <ControlledCollapse
                label={`Session timeline — ${breadcrumbs.length} event${breadcrumbs.length === 1 ? '' : 's'}`}
                isOpen={false}
              >
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
              </ControlledCollapse>
            )}

            {exception.sessionId && replayProbe?.hasChunks && (
              <div className={styles.section}>
                <h4 className={styles.sectionTitle}>Session Replay</h4>
                <ReplaySection
                  key={exception.sessionId}
                  logsUid={logsUid}
                  service={service}
                  environment={environment}
                  environmentLabel={clusterLabel}
                  sessionId={exception.sessionId}
                  fromMs={fromMs - SESSION_PAD_MS}
                  toMs={toMs + SESSION_PAD_MS}
                  mode={replayProbe.mode ?? 'recording'}
                  exceptionTsMs={exceptionTsMs}
                />
                <div className={styles.sectionDocsLink}>
                  <TextLink href={apmDocs.enableSessionReplay()} external variant="bodySmall">
                    Enable session replay
                  </TextLink>
                </div>
              </div>
            )}

            {feedback.length > 0 && <FeedbackSection entries={feedback} />}

            <div className={styles.footerLinks}>
              {isServer ? (
                <>
                  <a href={serverLogsUrl} target="_blank" rel="noopener noreferrer" className={styles.footerLink}>
                    <Icon name="file-alt" /> View Raw Loki Log
                  </a>
                  {serverTracesUrl && (
                    <>
                      <span className={styles.footerDivider}>|</span>
                      <a href={serverTracesUrl} target="_blank" rel="noopener noreferrer" className={styles.footerLink}>
                        <Icon name="gf-traces" /> View traces with this exception
                      </a>
                    </>
                  )}
                </>
              ) : (
                <>
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
                  <span className={styles.footerDivider}>|</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="bell"
                    onClick={onCreateAlert}
                    disabled={creatingAlert || hashes.length === 0}
                  >
                    {creatingAlert ? 'Preparing alert…' : 'Create alert'}
                  </Button>
                  <TextLink
                    href={apmDocs.createAlerts()}
                    external
                    variant="bodySmall"
                    className={styles.footerDocsLink}
                  >
                    About alert templates
                  </TextLink>
                </>
              )}
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

/**
 * Renders the source-map doctor's pass/fail checklist (#60). Pure presentation
 * of the backend diagnosis — the plugin never resolves the stack itself.
 */
function SourcemapChecklist({ result }: { result: SourcemapDoctorResult }) {
  const styles = useStyles2(getStyles);
  const icon = (status: string) =>
    status === 'pass' ? 'check-circle' : status === 'fail' ? 'exclamation-circle' : 'minus-circle';
  const color = (status: string) => (status === 'pass' ? '#3ba55d' : status === 'fail' ? '#d1465c' : '#8c95a5');
  return (
    <div className={styles.checklist}>
      <div className={styles.checklistSummary}>
        {result.ok
          ? 'Source map is published and fetchable — new exceptions on this build should resolve at ingest.'
          : 'Source map is missing or unreachable — that is why this stack stayed minified.'}
      </div>
      {result.checks.map((check, idx) => (
        <div key={idx} className={styles.checkRow}>
          <Icon name={icon(check.status) as any} style={{ color: color(check.status) }} />
          <span className={styles.checkName}>{check.name}</span>
          {check.detail && <span className={styles.checkDetail}>{check.detail}</span>}
        </div>
      ))}
      {result.sourceMapUrl && <div className={styles.checkDetail}>Map: {result.sourceMapUrl}</div>}
    </div>
  );
}

const FEEDBACK_DISPLAY_LIMIT = 20;

/** Category → Badge color, per M6 spec. Unknown categories fall back to gray. */
function feedbackBadgeColor(category: string): 'red' | 'blue' | 'darkgrey' {
  if (category === 'bug') {
    return 'red';
  }
  if (category === 'idea') {
    return 'blue';
  }
  return 'darkgrey';
}

/**
 * User feedback (M6): entries captured via @nais/apm's captureFeedback(),
 * joined to this issue by fingerprint. Rendered only when non-empty — the
 * caller (ExceptionDrawer) hides this section entirely otherwise, since
 * feedback is rare and an empty shell wastes drawer space.
 */
function FeedbackSection({ entries }: { entries: FeedbackEntry[] }) {
  const styles = useStyles2(getStyles);
  // API already returns newest-first; sort defensively so display order
  // doesn't depend on that contract holding forever.
  const sorted = [...entries].sort((a, b) => b.timeMs - a.timeMs);
  const shown = sorted.slice(0, FEEDBACK_DISPLAY_LIMIT);
  const extra = sorted.length - shown.length;

  return (
    <div className={styles.section}>
      <h4 className={styles.sectionTitle}>
        User Feedback ({sorted.length}){' '}
        <Badge
          text="Preview"
          color="orange"
          tooltip="Internal pilot only — free-text feedback goes to a shared log store, so this is gated on the personvernombud process and apps must warn users not to enter personal information."
        />
      </h4>
      <div className={styles.feedbackList}>
        {shown.map((entry, idx) => (
          <div key={idx} className={styles.feedbackItem}>
            <div className={styles.feedbackHeader}>
              <Badge text={entry.category} color={feedbackBadgeColor(entry.category)} />
              <span className={styles.feedbackTime}>{formatRelativeTime(entry.timeMs)}</span>
              {entry.email && <span className={styles.feedbackEmail}>{entry.email}</span>}
            </div>
            <div className={styles.feedbackMessage}>{entry.message}</div>
            {entry.pageUrl && <div className={styles.feedbackSecondary}>{cleanUrl(entry.pageUrl)}</div>}
          </div>
        ))}
        {extra > 0 && <div className={styles.feedbackMore}>+{extra} more</div>}
      </div>
      <div className={styles.sectionDocsLink}>
        <TextLink href={apmDocs.collectUserFeedback()} external variant="bodySmall">
          Collect user feedback
        </TextLink>
      </div>
    </div>
  );
}

/**
 * Issue triage controls (#57): resolve / ignore / reopen + assignee, shared
 * across all users via the backend's annotations event log. Rendered only
 * when the drawer was opened with a fingerprint (issueId param) — legacy
 * exceptionHash links have no stable identity to attach state to.
 */
function TriageControls({
  namespace,
  service,
  fingerprint,
}: {
  namespace: string;
  service: string;
  fingerprint: string;
}) {
  const styles = useStyles2(getStyles);
  const [state, setState] = useState<TriageState | null>(null);
  const [assignee, setAssignee] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getTriageStates(namespace, service)
      .then((states) => {
        if (!cancelled) {
          setState(states[fingerprint] ?? null);
          setAssignee(states[fingerprint]?.assignee ?? '');
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [namespace, service, fingerprint]);

  const act = async (action: 'resolve' | 'ignore' | 'unresolve' | 'assign', extra?: { assignee?: string }) => {
    setBusy(true);
    try {
      const next = await postTriageAction(namespace, service, fingerprint, { action, ...extra });
      setState(next);
      setAssignee(next.assignee ?? '');
    } finally {
      setBusy(false);
    }
  };

  const status = state?.status ?? 'active';
  return (
    <div className={styles.triageBar}>
      {status === 'resolved' && <Badge text="Resolved" color="green" />}
      {status === 'ignored' && <Badge text="Ignored" color="darkgrey" />}
      {status === 'active' && <Badge text="Unresolved" color="orange" />}
      {status === 'active' ? (
        <>
          <Button size="sm" variant="secondary" icon="check" disabled={busy} onClick={() => act('resolve')}>
            Resolve
          </Button>
          <Button size="sm" variant="secondary" icon="eye-slash" disabled={busy} onClick={() => act('ignore')}>
            Ignore
          </Button>
        </>
      ) : (
        <Button size="sm" variant="secondary" icon="history" disabled={busy} onClick={() => act('unresolve')}>
          Reopen
        </Button>
      )}
      <Input
        width={22}
        placeholder="Assignee…"
        value={assignee}
        disabled={busy}
        onChange={(e) => setAssignee(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && act('assign', { assignee })}
        onBlur={() => (state?.assignee ?? '') !== assignee && act('assign', { assignee })}
        prefix={<Icon name="user" />}
      />
      {state?.updatedBy && <span className={styles.triageMeta}>last change by {state.updatedBy}</span>}
      <TextLink
        href={apmDocs.triageAnIssue()}
        external
        variant="bodySmall"
        className={state?.updatedBy ? undefined : styles.triageHelp}
      >
        How triage works
      </TextLink>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  triageBar: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
  `,
  triageMeta: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    margin-left: auto;
  `,
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
  impactStrip: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  impactDivider: css`
    color: ${theme.colors.border.medium};
  `,
  feedbackList: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  feedbackItem: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(1)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
  `,
  feedbackHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  feedbackTime: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  feedbackEmail: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    margin-left: auto;
  `,
  feedbackMessage: css`
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.bodySmall.fontSize};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  feedbackSecondary: css`
    color: ${theme.colors.text.secondary};
    font-size: 11px;
    word-break: break-all;
  `,
  feedbackMore: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    text-align: center;
    padding-top: ${theme.spacing(0.5)};
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
    background: ${
      kind === 'exception' || kind === 'error'
        ? theme.colors.error.transparent
        : kind === 'measurement'
          ? theme.colors.warning.transparent
          : kind === 'event'
            ? theme.colors.success.transparent
            : theme.colors.primary.transparent
    };
    color: ${
      kind === 'exception' || kind === 'error'
        ? theme.colors.error.text
        : kind === 'measurement'
          ? theme.colors.warning.text
          : kind === 'event'
            ? theme.colors.success.text
            : theme.colors.primary.text
    };
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
  footerDocsLink: css`
    margin-left: auto;
  `,
  triageHelp: css`
    margin-left: auto;
  `,
  sectionDocsLink: css`
    margin-top: ${theme.spacing(0.5)};
  `,
  minifiedAlert: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  minifiedActions: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(2)};
  `,
  minifiedError: css`
    color: ${theme.colors.error.text};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  checklist: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(1)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
  `,
  checklistSummary: css`
    font-weight: ${theme.typography.fontWeightMedium};
    margin-bottom: ${theme.spacing(0.5)};
  `,
  checkRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  checkName: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    color: ${theme.colors.text.primary};
  `,
  checkDetail: css`
    color: ${theme.colors.text.secondary};
    word-break: break-all;
  `,
});
