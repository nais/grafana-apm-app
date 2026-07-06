import React, { useState } from 'react';
import { useStyles2, Icon, Button, Tooltip, Badge } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { scanNPlusOne, NPlusOneFinding } from '../../../api/analytics';
import { useFetch } from '../../../utils/useFetch';
import { DepTypeIcon } from '../../../components/DepTypeIcon';
import { buildExploreUrl } from '../../../utils/explore';

interface NPlusOneSectionProps {
  namespace: string;
  service: string;
  fromMs: number;
  toMs: number;
  tracesUid: string;
}

/**
 * "N+1 candidates" — the Database tab's confirm layer for N+1 query patterns
 * (issue #119 §4.3). Answers "where am I hammering the database?" by scanning a
 * bounded, cached sample of this service's traces for the same normalized
 * db.statement repeated many times within a single request.
 *
 * On-demand by design (§6, cost): nothing runs until the developer clicks "Scan
 * for N+1" — Tempo is cost-sensitive, so this is an explicit action, not a
 * background sweep. The backend owns the cost bounds, the normalization (every
 * statement here is a fingerprint, never a raw literal, §6), and the cache. Each
 * finding carries a per-system remediation hint (§5).
 */
export function NPlusOneSection({ namespace, service, fromMs, toMs, tracesUid }: NPlusOneSectionProps) {
  const styles = useStyles2(getStyles);
  const [scanned, setScanned] = useState(false);

  const { data, loading, error, refetch } = useFetch(
    () => scanNPlusOne(namespace, service, fromMs, toMs, tracesUid),
    [namespace, service, fromMs, toMs, tracesUid],
    { skip: !scanned }
  );

  const findings = data?.findings ?? [];
  const unavailable = data?.mode === 'unavailable';
  const hasResult = scanned && !loading && !error && !unavailable && !!data;
  const isEmpty = hasResult && findings.length === 0;

  return (
    <div className={styles.section}>
      <div className={styles.headerRow}>
        <div>
          <h4 className={styles.sectionTitle}>N+1 candidates</h4>
          <p className={styles.sectionSubtitle}>
            Scans a bounded, cached sample of this service&apos;s traces for the same normalized query repeated many
            times in a single request — the classic N+1 that a JOIN, batch-fetch, or pipeline collapses. On-demand,
            because trace scans are cost-sensitive. Statements are stripped to a fingerprint before display.
          </p>
        </div>
        <Button
          variant={scanned ? 'secondary' : 'primary'}
          size="sm"
          icon={loading ? 'fa fa-spinner' : 'search'}
          disabled={loading}
          onClick={() => (scanned ? refetch() : setScanned(true))}
        >
          {loading ? 'Scanning…' : scanned ? 'Re-scan' : 'Scan for N+1'}
        </Button>
      </div>

      {error && (
        <div className={styles.notice}>
          <Icon name="exclamation-triangle" />
          <span>{error}</span>
        </div>
      )}

      {unavailable && (
        <div className={styles.notice}>
          <Icon name="exclamation-triangle" />
          <span>
            {data?.note || 'Trace search is currently unavailable. Try again shortly or narrow the time range.'}
          </span>
        </div>
      )}

      {isEmpty && (
        <div className={styles.notice}>
          <Icon name="check-circle" />
          <span>
            No N+1 patterns found — no single request repeated the same query {data?.threshold ?? 10}× or more in the
            scanned window ({data ? formatWindow(data.windowSeconds) : ''}). Widen the range if you expected some.
          </span>
        </div>
      )}

      {hasResult && findings.length > 0 && (
        <>
          <ul className={styles.findingList}>
            {findings.map((f, i) => (
              <FindingCard key={`${f.traceId}:${f.dbSystem}:${f.statement}:${i}`} finding={f} tracesUid={tracesUid} />
            ))}
          </ul>
          <p className={styles.footnote}>
            Scanned {data.scannedTraces.toLocaleString()} candidate trace{data.scannedTraces === 1 ? '' : 's'} over the
            last {formatWindow(data.windowSeconds)}
            {data.truncated && ' (bounded sample — the scan limit was reached)'}.
          </p>
        </>
      )}
    </div>
  );
}

function FindingCard({ finding, tracesUid }: { finding: NPlusOneFinding; tracesUid: string }) {
  const styles = useStyles2(getStyles);

  const traceHref = finding.traceId
    ? buildExploreUrl({
        datasourceUid: tracesUid,
        queries: [{ refId: 'A', queryType: 'traceql', query: finding.traceId }],
      })
    : undefined;

  return (
    <li className={styles.findingCard}>
      <div className={styles.findingHead}>
        <span className={styles.systemCell}>
          <DepTypeIcon type={finding.dbSystem} size={16} />
          <span>{finding.dbSystem}</span>
        </span>
        <Badge text={`${finding.repeatCount}× in one request`} color="red" />
        {finding.table && <span className={styles.tableTag}>{finding.table}</span>}
        {traceHref && (
          <Tooltip content="View the offending trace">
            <a
              href={traceHref}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.traceLink}
              aria-label="View offending trace"
            >
              <Icon name="compass" size="sm" /> trace
            </a>
          </Tooltip>
        )}
      </div>
      <p className={styles.findingSummary}>
        <span className={styles.endpoint}>{finding.endpoint}</span> ran{' '}
        <code className={styles.statement}>{finding.statement}</code>{' '}
        <strong>
          {finding.repeatCount}× ({finding.totalDbSpans} DB span{finding.totalDbSpans === 1 ? '' : 's'} in the request)
        </strong>
      </p>
      <p className={styles.remediation}>
        <Icon name="wrench" size="sm" /> {finding.remediation}
      </p>
    </li>
  );
}

function formatWindow(seconds: number): string {
  if (seconds >= 3600) {
    const h = seconds / 3600;
    return `${h % 1 === 0 ? h : h.toFixed(1)}h`;
  }
  if (seconds >= 60) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${seconds}s`;
}

const getStyles = (theme: GrafanaTheme2) => ({
  section: css`
    display: flex;
    flex-direction: column;
  `,
  headerRow: css`
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: ${theme.spacing(2)};
  `,
  sectionTitle: css`
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    margin: 0 0 ${theme.spacing(0.5)} 0;
    color: ${theme.colors.text.primary};
  `,
  sectionSubtitle: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin: 0 0 ${theme.spacing(1)} 0;
  `,
  findingList: css`
    list-style: none;
    margin: ${theme.spacing(1)} 0 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  findingCard: css`
    border: 1px solid ${theme.colors.border.weak};
    border-left: 3px solid ${theme.colors.error.border};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
    padding: ${theme.spacing(1.5)};
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.75)};
  `,
  findingHead: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: ${theme.spacing(1)};
  `,
  systemCell: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    text-transform: capitalize;
  `,
  findingSummary: css`
    margin: 0;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.primary};
    line-height: 1.5;
  `,
  endpoint: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    color: ${theme.colors.text.primary};
  `,
  statement: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: 0 ${theme.spacing(0.5)};
    word-break: break-word;
  `,
  tableTag: css`
    display: inline-block;
    padding: 0 ${theme.spacing(0.75)};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
  remediation: css`
    margin: 0;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  traceLink: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.25)};
    margin-left: auto;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    &:hover {
      color: ${theme.colors.text.link};
    }
  `,
  notice: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1.5)};
    margin-top: ${theme.spacing(1)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  footnote: css`
    margin: ${theme.spacing(1)} 0 0 0;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
});
