import React from 'react';
import { Badge, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getFrontendVersions, VersionStat } from '../../../../api/client';
import { useFetch } from '../../../../utils/useFetch';
import { useTimeRange } from '../../../../utils/timeRange';
import { DataState } from '../../../../components/DataState';

interface VersionsPanelProps {
  namespace: string;
  service: string;
  environment?: string;
}

/**
 * Per-version release health (#64 Phase 1): distinct sessions, adoption
 * share, error-free-session rate, and exception occurrences per app_version,
 * computed query-time from Faro streams in Loki. Deploy times come from
 * nais-apm:deploy Grafana annotations when the Phase 0 contract is in place.
 */
export function VersionsPanel({ namespace, service, environment }: VersionsPanelProps) {
  const styles = useStyles2(getStyles);
  const { fromMs, toMs } = useTimeRange();

  const { data, loading, error } = useFetch(
    () => getFrontendVersions(namespace, service, fromMs, toMs, environment),
    [namespace, service, fromMs, toMs, environment]
  );

  const versions = data?.versions ?? [];

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h6 className={styles.title}>Versions</h6>
        <span className={styles.subtitle}>Answering: did this start with today&apos;s release?</span>
      </div>
      <DataState
        loading={loading}
        error={error ? 'Failed to load versions' : data?.unavailable ? 'Loki is not available' : null}
        empty={versions.length === 0}
        loadingText="Loading versions…"
        emptyTitle="No versions"
        emptyMessage="No app_version data in the selected time range."
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Version</th>
              <th>Deployed</th>
              <th className={styles.num}>Sessions</th>
              <th className={styles.shareCol}>Adoption</th>
              <th className={styles.num}>Error-free %</th>
              <th className={styles.num}>Exceptions</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <VersionRow key={v.version} stat={v} isLatest={v.version === data?.latestVersion} />
            ))}
          </tbody>
        </table>
      </DataState>
    </div>
  );
}

function VersionRow({ stat, isLatest }: { stat: VersionStat; isLatest: boolean }) {
  const styles = useStyles2(getStyles);
  return (
    <tr>
      <td className={styles.versionCell}>
        <span className={styles.version} title={stat.version}>
          {shortVersion(stat.version)}
        </span>
        {isLatest && <Badge className={styles.badge} text="latest" color="green" />}
      </td>
      <td className={styles.deployed}>{stat.deployedAtMs ? formatRelativeTime(stat.deployedAtMs) : '—'}</td>
      <td className={styles.num}>{Math.round(stat.sessions)}</td>
      <td className={styles.shareCol}>
        <div className={styles.shareBar}>
          <div className={styles.shareFill} style={{ width: `${Math.max(2, Math.round(stat.adoption * 100))}%` }} />
        </div>
        <span className={styles.shareLabel}>{Math.round(stat.adoption * 100)}%</span>
      </td>
      <td className={`${styles.num} ${errorFreeClass(stat)}`}>
        {stat.sessions > 0 ? `${(stat.errorFreeRate * 100).toFixed(1)}%` : '—'}
      </td>
      <td className={styles.num}>{Math.round(stat.exceptions)}</td>
    </tr>
  );
}

/** Short SHA display: versions are commit SHAs by convention (#64). */
function shortVersion(version: string): string {
  return version.length > 10 ? version.slice(0, 10) : version;
}

function formatRelativeTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  if (isNaN(diffMs) || diffMs < 0) {
    return new Date(epochMs).toLocaleString();
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

function errorFreeClass(stat: VersionStat): string {
  if (stat.sessions === 0) {
    return '';
  }
  const pct = stat.errorFreeRate * 100;
  return pct >= 99 ? 'version-ok' : pct >= 95 ? 'version-warn' : 'version-bad';
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)};
    width: 100%;
    height: 100%;
    overflow: auto;
  `,
  header: css`
    display: flex;
    align-items: baseline;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.5, 1)};
  `,
  title: css`
    margin: 0;
    font-size: ${theme.typography.body.fontSize};
  `,
  subtitle: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: ${theme.typography.bodySmall.fontSize};
    th {
      text-align: left;
      color: ${theme.colors.text.secondary};
      font-weight: ${theme.typography.fontWeightMedium};
      padding: ${theme.spacing(0.5, 1)};
      border-bottom: 1px solid ${theme.colors.border.weak};
    }
    td {
      padding: ${theme.spacing(0.75, 1)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: top;
    }
    td.version-ok {
      color: ${theme.colors.success.text};
    }
    td.version-warn {
      color: ${theme.colors.warning.text};
    }
    td.version-bad {
      color: ${theme.colors.error.text};
    }
  `,
  versionCell: css`
    white-space: nowrap;
  `,
  version: css`
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
  badge: css`
    margin-left: ${theme.spacing(1)};
  `,
  deployed: css`
    white-space: nowrap;
    color: ${theme.colors.text.secondary};
  `,
  num: css`
    text-align: right;
    white-space: nowrap;
    width: 1%;
  `,
  shareCol: css`
    white-space: nowrap;
    width: 140px;
  `,
  shareBar: css`
    display: inline-block;
    vertical-align: middle;
    width: 80px;
    height: 6px;
    border-radius: 3px;
    background: ${theme.colors.background.secondary};
    margin-right: ${theme.spacing(1)};
  `,
  shareFill: css`
    height: 100%;
    border-radius: 3px;
    background: ${theme.colors.primary.main};
    opacity: 0.7;
  `,
  shareLabel: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
