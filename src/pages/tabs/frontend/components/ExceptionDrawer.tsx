import React, { useEffect, useState } from 'react';
import { Drawer, Button, Icon, Spinner, Alert, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { otel } from '../../../../otelconfig';
import { PLUGIN_BASE_URL } from '../../../../constants';
import { sanitizeLabelValue } from '../../../../utils/sanitize';
import { usePluginLabelOverrides } from '../../../../utils/datasources';

interface ExceptionDrawerProps {
  hash: string;
  service: string;
  namespace: string;
  environment?: string;
  logsUid: string;
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
  sessionId?: string;
}

export function ExceptionDrawer({ hash, service, namespace, environment, logsUid, onClose }: ExceptionDrawerProps) {
  const styles = useStyles2(getStyles);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exception, setException] = useState<ParsedException | null>(null);
  const labelOverrides = usePluginLabelOverrides();

  useEffect(() => {
    let cancelled = false;

    const fl = otel.faroLoki;
    const clusterLabel = labelOverrides.deploymentEnvLabel || otel.labels.deploymentEnv;
    const clusterStream = environment ? `, ${clusterLabel}="${sanitizeLabelValue(environment)}"` : '';
    const query = `{${fl.serviceName}="${sanitizeLabelValue(service)}", ${fl.kind}="${fl.kindException}"${clusterStream}} | logfmt | ${fl.hash}="${sanitizeLabelValue(hash)}"`;

    lastValueFrom(
      getBackendSrv().fetch<any>({
        url: `/api/datasources/proxy/uid/${encodeURIComponent(logsUid)}/loki/api/v1/query_range`,
        params: {
          query,
          limit: '1',
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

        // Loki returns values as [timestamp_ns, log_line_string]
        const rawLine = streams[0].values[0][1];
        const parsed = parseLogfmt(rawLine);

        setException({
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
          appNamespace: parsed.app_namespace,
          sessionId: parsed.session_id,
        });
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
  }, [hash, service, environment, logsUid, labelOverrides]);

  const envParam = environment ? `&environment=${encodeURIComponent(environment)}` : '';
  const nsSegment = encodeURIComponent(namespace || '_');

  const logsUrl = exception?.sessionId
    ? `${PLUGIN_BASE_URL}/services/${nsSegment}/${encodeURIComponent(service)}?tab=logs&from=now-6h&to=now${envParam}&includeFaro=true&logSearch=${encodeURIComponent(exception.sessionId)}`
    : `${PLUGIN_BASE_URL}/services/${nsSegment}/${encodeURIComponent(service)}?tab=logs&from=now-6h&to=now${envParam}&includeFaro=true&kindFilter=exception&logSearch=${encodeURIComponent(hash)}`;

  return (
    <Drawer
      title={exception?.type || 'Exception Details'}
      subtitle={exception?.value || hash}
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
            <div className={styles.actions}>
              {exception.sessionId && (
                <Button
                  variant="primary"
                  icon="history"
                  onClick={() => {
                    window.location.href = logsUrl;
                  }}
                >
                  View Session Timeline (Breadcrumbs)
                </Button>
              )}
              <Button
                variant="secondary"
                icon="file-alt"
                onClick={() => {
                  const fallbackUrl = `${PLUGIN_BASE_URL}/services/${nsSegment}/${encodeURIComponent(service)}?tab=logs&from=now-6h&to=now${envParam}&includeFaro=true&kindFilter=exception&logSearch=${encodeURIComponent(hash)}`;
                  window.location.href = fallbackUrl;
                }}
              >
                View Raw Log
              </Button>
            </div>

            <div className={styles.section}>
              <h4 className={styles.sectionTitle}>Context Metadata</h4>
              <div className={styles.metadataGrid}>
                <MetaItem
                  label="Browser"
                  value={
                    exception.browserName ? `${exception.browserName} ${exception.browserVersion ?? ''}` : undefined
                  }
                  icon="chrome"
                />
                <MetaItem label="OS" value={exception.browserOs} icon="desktop" />
                <MetaItem label="URL" value={exception.pageUrl} link={exception.pageUrl} icon="link" />
                <MetaItem label="Page ID / Route" value={exception.pageId} icon="compass" />
                <MetaItem label="App instance" value={exception.appName} icon="cube" />
                <MetaItem label="Session ID" value={exception.sessionId} icon="user" />
                <MetaItem label="Timestamp" value={exception.timestamp} icon="clock-nine" />
              </div>
            </div>

            {exception.stacktrace && (
              <div className={styles.section}>
                <h4 className={styles.sectionTitle}>Stack Trace</h4>
                <pre className={styles.stacktrace}>
                  <code>{formatStackTrace(exception.stacktrace)}</code>
                </pre>
              </div>
            )}
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

function formatStackTrace(stack: string): React.ReactNode[] {
  const lines = stack.split('\n');
  return lines.map((line, i) => {
    const isAtLine = line.trim().startsWith('at ');
    if (!isAtLine) {
      return (
        <div key={i} style={{ color: '#a6acb9' }}>
          {line}
        </div>
      );
    }

    // Parse: "at FunctionName (http://url/path/file.js:line:col)" or "at http://url/path/file.js:line:col"
    const atRegex = /at\s+(.+?)\s*\((.+?)\)/;
    const directRegex = /at\s+(https?:\/\/.+)/;

    let funcName = '';
    let filePath = '';

    const matchAt = line.match(atRegex);
    if (matchAt) {
      funcName = matchAt[1];
      filePath = matchAt[2];
    } else {
      const matchDirect = line.match(directRegex);
      if (matchDirect) {
        filePath = matchDirect[1];
      }
    }

    if (!filePath) {
      return (
        <div key={i} style={{ color: '#8c95a5' }}>
          {line}
        </div>
      );
    }

    // Check if the path contains line/col numbers
    const parts = filePath.split(':');
    let lineCol = '';
    let fileClean = filePath;
    if (parts.length >= 3) {
      // e.g. ["https", "//site/file.js", "12", "34"] -> line:col is the last two
      const col = parts.pop();
      const ln = parts.pop();
      lineCol = `:${ln}:${col}`;
      fileClean = parts.join(':');
    }

    // Try to get clean file name (strip protocol/host)
    let displayFile = fileClean;
    try {
      if (fileClean.startsWith('http')) {
        const url = new URL(fileClean);
        displayFile = url.pathname;
      }
    } catch {
      // ignore
    }

    return (
      <div key={i} style={{ margin: '2px 0' }}>
        <span style={{ color: '#f97316', fontWeight: 500 }}>at </span>
        {funcName && <span style={{ color: '#38bdf8' }}>{funcName} </span>}
        <span style={{ color: '#8c95a5' }}>({displayFile}</span>
        <span style={{ color: '#f43f5e', fontWeight: 'bold' }}>{lineCol}</span>
        <span style={{ color: '#8c95a5' }}>)</span>
      </div>
    );
  });
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
});
