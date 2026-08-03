import { useEffect, useState } from 'react';
import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { getIssueOccurrences, IssueSource } from '../../../api/client';
import { otel } from '../../../otelconfig';
import { sanitizeLabelValue } from '../../../utils/sanitize';
import { usePluginLabelOverrides } from '../../../utils/datasources';
import { parseLogfmt } from './exception-utils';

/** Millisecond timestamp → Loki nanosecond string (string concat avoids float precision loss). */
export function msToNs(ms: number): string {
  return `${Math.floor(ms)}000000`;
}

/**
 * One occurrence as the drawer renders it. Browser occurrences carry the Faro
 * session/browser/user fields; server occurrences carry pod/level and reuse
 * type/value/stacktrace/timestamp. The absence of `sessionId` on server
 * occurrences is load-bearing — the browser-only sections (session timeline,
 * replay, feedback) already gate on it and so auto-hide for server issues.
 */
export interface ParsedException {
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
  // Server-issue fields (#84):
  pod?: string;
  level?: string;
  /** Distributed-trace correlation ID — deep-links the line to its full trace. */
  traceId?: string;
  spanId?: string;
  /** Remaining structured-metadata / body fields the line carries (server issues). */
  attributes?: Record<string, string>;
}

/**
 * Aggregate impact across the returned occurrences. `uniqueSessions` doubles as
 * the pod count for server issues (the drawer relabels sessions↔pods by
 * source); `pods` is set for server issues so callers don't have to guess.
 */
export interface AggregatedStats {
  uniqueUsers: number;
  uniqueSessions: number;
  appVersions: string[];
  browsers: string[];
  total: number;
  firstSeenMs?: number;
  lastSeenMs?: number;
  /** Distinct pods (server issues). */
  pods?: number;
}

export interface UseIssueOccurrencesOptions {
  source: IssueSource;
  /** Alloy hashes (browser issues). */
  hashes: string[];
  /** Fingerprint (server issues, and the join key for browser feedback). */
  issueId: string;
  /**
   * Group title — forwarded to the server occurrences endpoint so it can
   * anchor its capped Loki scan to matching lines (recall on noisy services).
   */
  title?: string;
  /** Exception type from the issue group, when it carries one. */
  issueType?: string;
  service: string;
  namespace: string;
  environment?: string;
  logsUid: string;
  fromMs: number;
  toMs: number;
  /** True while a browser deep link is still resolving to its member hashes. */
  resolving?: boolean;
}

export interface UseIssueOccurrencesResult {
  loading: boolean;
  error: string | null;
  source: IssueSource;
  occurrences: ParsedException[];
  stats: AggregatedStats | null;
  truncated?: boolean;
  /** Server-log shape the matched lines came from (server issues only). */
  shape?: 'otlp' | 'json' | 'plaintext';
}

/**
 * Loads and normalizes the occurrences behind an exception drawer, abstracting
 * the two data paths (#84): browser issues query Loki directly by Alloy hash;
 * server issues fetch the backend occurrences endpoint (which re-scans the log
 * pipelines and filters by recomputed fingerprint). Both resolve to the same
 * `{ occurrences, stats }` shape so the drawer renders one way.
 */
export function useIssueOccurrences(opts: UseIssueOccurrencesOptions): UseIssueOccurrencesResult {
  const {
    source,
    hashes,
    issueId,
    title,
    issueType,
    service,
    namespace,
    environment,
    logsUid,
    fromMs,
    toMs,
    resolving,
  } = opts;
  const labelOverrides = usePluginLabelOverrides();
  const fl = otel.faroLoki;
  const clusterLabel = labelOverrides.deploymentEnvLabel || otel.labels.deploymentEnv;
  const clusterStream = environment ? `, ${clusterLabel}="${sanitizeLabelValue(environment)}"` : '';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [occurrences, setOccurrences] = useState<ParsedException[]>([]);
  const [stats, setStats] = useState<AggregatedStats | null>(null);
  const [truncated, setTruncated] = useState<boolean | undefined>(undefined);
  const [shape, setShape] = useState<'otlp' | 'json' | 'plaintext' | undefined>(undefined);

  // Stable key so the browser effect doesn't refire on array identity.
  const hashesKey = hashes.map(sanitizeLabelValue).join('|');

  // ---- Server path: backend occurrences endpoint (#84) ----
  useEffect(() => {
    if (source !== 'server') {
      return;
    }
    if (!issueId) {
      setLoading(true);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getIssueOccurrences(namespace, service, issueId, fromMs, toMs, environment || undefined, {
      title,
      type: issueType,
    })
      .then((res) => {
        if (cancelled) {
          return;
        }
        if (res.unavailable) {
          setError('Loki is not available for this environment.');
          setOccurrences([]);
          setStats(null);
          setLoading(false);
          return;
        }
        const occ: ParsedException[] = res.occurrences.map((o) => ({
          timestamp: o.timeMs ? new Date(o.timeMs).toISOString() : undefined,
          type: o.type,
          value: o.message,
          stacktrace: o.stacktrace,
          appVersion: o.version,
          pod: o.pod,
          level: o.level,
          traceId: o.traceId,
          spanId: o.spanId,
          attributes: o.attributes,
        }));
        setOccurrences(occ);
        setShape(res.shape);
        setStats({
          uniqueUsers: 0,
          uniqueSessions: res.stats.pods,
          appVersions: res.stats.versions ?? [],
          browsers: [],
          total: res.stats.total,
          firstSeenMs: res.stats.firstSeenMs || undefined,
          lastSeenMs: res.stats.lastSeenMs || undefined,
          pods: res.stats.pods,
        });
        setTruncated(res.truncated);
        if (occ.length === 0) {
          setError('No matching server-log occurrences found for this issue in range.');
        }
        setLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.message || 'Failed to fetch issue occurrences.');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source, issueId, title, issueType, namespace, service, environment, fromMs, toMs]);

  // ---- Browser path: direct Loki query by Alloy hash ----
  useEffect(() => {
    if (source !== 'browser') {
      return;
    }
    let cancelled = false;
    // While the deep link is still resolving to hashes, keep the spinner and
    // don't query — the same instance re-runs this once hashes land.
    if (resolving || hashesKey === '') {
      setLoading(true);
      return;
    }
    setLoading(true);
    setError(null);

    const single = !hashesKey.includes('|');
    const lineFilter = single ? `|= \`${fl.hash}=${hashesKey}\`` : `|~ \`${fl.hash}=(${hashesKey})\``;
    const fieldFilter = single ? `${fl.hash}="${hashesKey}"` : `${fl.hash}=~"(${hashesKey})"`;
    const query = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"${clusterStream}} ${lineFilter} | logfmt | ${fieldFilter}`;

    lastValueFrom(
      getBackendSrv().fetch<any>({
        url: `/api/datasources/proxy/uid/${encodeURIComponent(logsUid)}/loki/api/v1/query_range`,
        params: {
          query,
          limit: '100',
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
          setOccurrences([]);
          setStats(null);
          setLoading(false);
          return;
        }

        const uniqueSessionsMap = new Map<string, ParsedException>();
        let total = 0;
        const users = new Set<string>();
        const sessions = new Set<string>();
        const versions = new Set<string>();
        const browsers = new Set<string>();
        let firstSeenMs: number | undefined;
        let lastSeenMs: number | undefined;

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

            const parsedTs = ex.timestamp ? Date.parse(ex.timestamp) : NaN;
            if (Number.isFinite(parsedTs)) {
              firstSeenMs = firstSeenMs === undefined ? parsedTs : Math.min(firstSeenMs, parsedTs);
              lastSeenMs = lastSeenMs === undefined ? parsedTs : Math.max(lastSeenMs, parsedTs);
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
              browsers.add(`${parsed.browser_name} ${parsed.browser_version || ''}`.trim());
            }
          });
        });

        setStats({
          uniqueUsers: users.size,
          uniqueSessions: sessions.size,
          appVersions: Array.from(versions),
          browsers: Array.from(browsers),
          total,
          firstSeenMs,
          lastSeenMs,
        });
        setOccurrences(Array.from(uniqueSessionsMap.values()));
        setTruncated(undefined);
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
    // `labelOverrides` (the raw object) is deliberately NOT a dep: the effect
    // reads it only via the derived `clusterStream` string, already listed.
    // Depending on the object refired the effect on every unrelated re-render,
    // and since each fetch sets new-identity state, that self-sustained a
    // refetch loop (regression covered in ExceptionDrawer.test.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    source,
    resolving,
    hashesKey,
    service,
    environment,
    logsUid,
    clusterStream,
    fromMs,
    toMs,
    fl.hash,
    fl.kind,
    fl.kindException,
    fl.serviceName,
  ]);

  return { loading, error, source, occurrences, stats, truncated, shape };
}
