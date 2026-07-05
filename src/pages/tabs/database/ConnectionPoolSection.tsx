import React from 'react';
import { useStyles2, useTheme2, Icon, Badge } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { DBPoolRuntime } from '../../../api/client';
import { getTableStyles } from '../../../components/SortableTable';

interface ConnectionPoolSectionProps {
  dbPool: DBPoolRuntime;
}

const POOL_HEALTH_NOTE =
  'Point-in-time pool gauges (active/idle/max/pending/timeouts), averaged over the selected time range. ' +
  'See the "Connection Acquisition" charts above for wait-time and create-time distributions.';

/**
 * Connection pool health — elevated from RuntimeTab's DBPoolCard (issue #14).
 * Reuses the same DBPoolRuntime snapshot already computed by the backend's
 * /runtime endpoint; no new data source. Acquisition-time distributions
 * (verified present in production as db_client_connections_wait_time /
 * create_time histograms) are rendered as Scenes panels in DatabaseTab
 * instead — this table only covers what /runtime already returns.
 */
export function ConnectionPoolSection({ dbPool }: ConnectionPoolSectionProps) {
  const styles = useStyles2(getStyles);

  if (!dbPool.pools || dbPool.pools.length === 0) {
    return null;
  }

  return (
    <div className={styles.section}>
      <h4 className={styles.sectionHeader}>
        <Icon name="database" />
        <span>Connection Pool Health</span>
        <Badge text={`${dbPool.pools.length} pool${dbPool.pools.length !== 1 ? 's' : ''}`} color="orange" />
        <span className={styles.helpIcon} title={POOL_HEALTH_NOTE}>
          <Icon name="info-circle" size="sm" />
        </span>
      </h4>
      <table className={styles.table} aria-label="Connection pool health">
        <thead>
          <tr>
            <th scope="col">Pool</th>
            <th scope="col">Active</th>
            <th scope="col">Idle</th>
            <th scope="col">Max</th>
            <th scope="col">Pending</th>
            <th scope="col">Utilization</th>
            <th scope="col">Timeouts/s</th>
          </tr>
        </thead>
        <tbody>
          {dbPool.pools.map((pool) => (
            <tr key={pool.name}>
              <td className={styles.nameCell} title={pool.name}>
                <div className={styles.nameCellInner}>
                  <Badge text={pool.type} color="orange" />
                  <span>{pool.name}</span>
                </div>
              </td>
              <td className={styles.numCell}>{pool.active.toFixed(1)}</td>
              <td className={styles.numCell}>{pool.idle.toFixed(1)}</td>
              <td className={styles.numCell}>{pool.max}</td>
              <td className={pool.pending > 0 ? styles.warnCell : styles.numCell}>{pool.pending.toFixed(1)}</td>
              <td className={styles.numCell}>
                <UtilizationBar value={pool.utilization} />
              </td>
              <td className={pool.timeoutRate > 0 ? styles.errorCell : styles.numCell}>
                {pool.timeoutRate.toFixed(3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UtilizationBar({ value }: { value: number }) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const fillColor =
    value > 90 ? theme.colors.error.main : value > 70 ? theme.colors.warning.main : theme.colors.success.main;
  // The fill colour is the only visual cue for the health band — expose it as
  // text so it does not rely on colour alone (WCAG 1.4.1).
  const status = value > 90 ? 'critical' : value > 70 ? 'warning' : 'healthy';
  const pct = value === 0 ? '0%' : value < 1 ? `${value.toFixed(1)}%` : `${value.toFixed(0)}%`;

  return (
    <div className={styles.utilBar} role="img" aria-label={`${pct} utilization, ${status}`}>
      <div className={styles.utilBarBg} aria-hidden="true">
        <div className={styles.utilBarFill} style={{ width: `${Math.min(value, 100)}%`, backgroundColor: fillColor }} />
      </div>
      <span className={styles.utilLabel} aria-hidden="true">
        {pct}
      </span>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  ...getTableStyles(theme),
  section: css`
    display: flex;
    flex-direction: column;
  `,
  sectionHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    margin-bottom: ${theme.spacing(1)};
    color: ${theme.colors.text.primary};
  `,
  helpIcon: css`
    color: ${theme.colors.text.secondary};
    cursor: help;
    opacity: 0.6;
    &:hover {
      opacity: 1;
    }
  `,
  warnCell: css`
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.warning.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  utilBar: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    justify-content: flex-end;
  `,
  utilBarBg: css`
    flex: 1;
    height: 6px;
    background: ${theme.colors.background.secondary};
    border-radius: 3px;
    overflow: hidden;
    min-width: 60px;
  `,
  utilBarFill: css`
    height: 100%;
    border-radius: 3px;
    transition: width 0.3s ease;
  `,
  utilLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    min-width: 36px;
    text-align: right;
  `,
});
