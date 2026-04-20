import React from 'react';
import { useStyles2, useTheme2, LoadingPlaceholder, Alert, Icon, Badge } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import {
  getRuntimeMetrics,
  RuntimeResponse,
  JVMRuntime,
  NodeJSRuntime,
  DBPoolRuntime,
  KafkaRuntime,
} from '../../api/client';
import { useFetch } from '../../utils/useFetch';

interface RuntimeTabProps {
  service: string;
  namespace: string;
  fromMs: number;
  toMs: number;
}

export function RuntimeTab({ service, namespace, fromMs, toMs }: RuntimeTabProps) {
  const styles = useStyles2(getStyles);
  const { data, loading, error } = useFetch<RuntimeResponse>(
    () => getRuntimeMetrics(namespace, service, fromMs, toMs),
    [service, namespace, fromMs, toMs]
  );

  if (loading) {
    return <LoadingPlaceholder text="Detecting runtime metrics..." />;
  }

  if (error) {
    return (
      <Alert severity="error" title="Error">
        {error}
      </Alert>
    );
  }

  const hasAny = data?.jvm || data?.nodejs || data?.dbPool || data?.kafka;

  if (!hasAny) {
    return (
      <Alert severity="info" title="No runtime metrics detected">
        This service does not emit JVM, Node.js, database pool, or Kafka client metrics. Runtime metrics are emitted by
        the application&apos;s Micrometer, prom-client, or OTel SDK instrumentation.
      </Alert>
    );
  }

  return (
    <div className={styles.container}>
      {data?.jvm && <JVMCard jvm={data.jvm} />}
      {data?.nodejs && <NodeJSCard nodejs={data.nodejs} />}
      {data?.dbPool && <DBPoolCard dbPool={data.dbPool} />}
      {data?.kafka && <KafkaCard kafka={data.kafka} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// JVM Card
// ---------------------------------------------------------------------------

function JVMCard({ jvm }: { jvm: JVMRuntime }) {
  const styles = useStyles2(getStyles);

  const heapPct = jvm.heapMax > 0 ? (jvm.heapUsed / jvm.heapMax) * 100 : 0;
  const cpuPct = jvm.cpuUtilization * 100;

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <Icon name="heart" />
        <span>JVM Runtime</span>
        <Badge text={`${jvm.podCount} pod${jvm.podCount !== 1 ? 's' : ''}`} color="blue" />
        {jvm.versions?.map((v) => (
          <Badge key={v.version} text={v.version} color="purple" />
        ))}
        {jvm.uptime > 0 && <span className={styles.uptimeBadge}>up {formatUptime(jvm.uptime)}</span>}
      </div>

      <div className={styles.metricsGrid}>
        {/* CPU */}
        {jvm.cpuUtilization > 0 && (
          <div className={styles.metricGroup}>
            <h5 className={styles.groupTitle}>CPU</h5>
            <div className={styles.metricRow}>
              <span className={styles.metricLabel}>Utilization</span>
              <span className={styles.metricValue}>{cpuPct.toFixed(1)}%</span>
            </div>
            <UtilizationBar value={cpuPct} />
            {jvm.cpuCount > 0 && (
              <div className={styles.metricRow}>
                <span className={styles.metricLabel}>CPU Cores</span>
                <span className={styles.metricValue}>{jvm.cpuCount}</span>
              </div>
            )}
          </div>
        )}

        {/* Memory */}
        <div className={styles.metricGroup}>
          <h5 className={styles.groupTitle}>Memory</h5>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Heap Used</span>
            <span className={styles.metricValue}>{formatBytes(jvm.heapUsed)}</span>
          </div>
          <UtilizationBar value={heapPct} />
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Heap Max</span>
            <span className={styles.metricValue}>{formatBytes(jvm.heapMax)}</span>
          </div>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Non-Heap Used</span>
            <span className={styles.metricValue}>{formatBytes(jvm.nonHeapUsed)}</span>
          </div>
          {jvm.bufferUsed > 0 && (
            <div className={styles.metricRow}>
              <span className={styles.metricLabel}>Buffers</span>
              <span className={styles.metricValue}>{formatBytes(jvm.bufferUsed)}</span>
            </div>
          )}
        </div>

        {/* GC */}
        <div className={styles.metricGroup}>
          <h5 className={styles.groupTitle}>Garbage Collection</h5>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>GC Rate</span>
            <span className={styles.metricValue}>{jvm.gcPauseRate.toFixed(2)}/s</span>
          </div>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Avg Pause</span>
            <span className={styles.metricValue}>{formatMs(jvm.gcPauseAvg)}</span>
          </div>
          {jvm.gcOverhead > 0 && (
            <div className={styles.metricRow}>
              <span className={styles.metricLabel}>GC Overhead</span>
              <span className={jvm.gcOverhead > 0.05 ? styles.warnValue : styles.metricValue}>
                {(jvm.gcOverhead * 100).toFixed(2)}%
              </span>
            </div>
          )}
        </div>

        {/* Threads */}
        <div className={styles.metricGroup}>
          <h5 className={styles.groupTitle}>Threads</h5>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Live</span>
            <span className={styles.metricValue}>{Math.round(jvm.threadsLive)}</span>
          </div>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Daemon</span>
            <span className={styles.metricValue}>{Math.round(jvm.threadsDaemon)}</span>
          </div>
          {jvm.threadsPeak > 0 && (
            <div className={styles.metricRow}>
              <span className={styles.metricLabel}>Peak</span>
              <span className={styles.metricValue}>{Math.round(jvm.threadsPeak)}</span>
            </div>
          )}
          {jvm.threadStates && Object.keys(jvm.threadStates).length > 0 && <ThreadStateBar states={jvm.threadStates} />}
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Classes Loaded</span>
            <span className={styles.metricValue}>{Math.round(jvm.classesLoaded).toLocaleString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node.js Card
// ---------------------------------------------------------------------------

function NodeJSCard({ nodejs }: { nodejs: NodeJSRuntime }) {
  const styles = useStyles2(getStyles);

  const heapPct = nodejs.heapTotal > 0 ? (nodejs.heapUsed / nodejs.heapTotal) * 100 : 0;
  const elUtilPct = nodejs.eventLoopUtil * 100;
  const fdPct = nodejs.maxFds > 0 ? (nodejs.openFds / nodejs.maxFds) * 100 : 0;

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <Icon name="heart" />
        <span>Node.js Runtime</span>
        <Badge text={`${nodejs.podCount} pod${nodejs.podCount !== 1 ? 's' : ''}`} color="green" />
        {nodejs.versions?.map((v) => (
          <Badge key={v.version} text={`v${v.version}`} color="purple" />
        ))}
      </div>

      <div className={styles.metricsGrid}>
        {/* Event Loop */}
        <div className={styles.metricGroup}>
          <h5 className={styles.groupTitle}>Event Loop</h5>
          {nodejs.eventLoopUtil > 0 && (
            <>
              <div className={styles.metricRow}>
                <span className={styles.metricLabel}>Utilization</span>
                <span className={elUtilPct > 80 ? styles.warnValue : styles.metricValue}>{elUtilPct.toFixed(1)}%</span>
              </div>
              <UtilizationBar value={elUtilPct} />
            </>
          )}
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>P99 Delay</span>
            <span className={styles.metricValue}>{formatMs(nodejs.eventLoopP99)}</span>
          </div>
          {nodejs.eventLoopP90 > 0 && (
            <div className={styles.metricRow}>
              <span className={styles.metricLabel}>P90 Delay</span>
              <span className={styles.metricValue}>{formatMs(nodejs.eventLoopP90)}</span>
            </div>
          )}
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>P50 Delay</span>
            <span className={styles.metricValue}>{formatMs(nodejs.eventLoopP50)}</span>
          </div>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Mean Delay</span>
            <span className={styles.metricValue}>{formatMs(nodejs.eventLoopMean)}</span>
          </div>
        </div>

        {/* Memory */}
        <div className={styles.metricGroup}>
          <h5 className={styles.groupTitle}>Memory</h5>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Heap Used</span>
            <span className={styles.metricValue}>{formatBytes(nodejs.heapUsed)}</span>
          </div>
          <UtilizationBar value={heapPct} />
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Heap Total</span>
            <span className={styles.metricValue}>{formatBytes(nodejs.heapTotal)}</span>
          </div>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>External</span>
            <span className={styles.metricValue}>{formatBytes(nodejs.externalMem)}</span>
          </div>
          {nodejs.rss > 0 && (
            <div className={styles.metricRow}>
              <span className={styles.metricLabel}>RSS</span>
              <span className={styles.metricValue}>{formatBytes(nodejs.rss)}</span>
            </div>
          )}
        </div>

        {/* CPU & Process */}
        <div className={styles.metricGroup}>
          <h5 className={styles.groupTitle}>CPU &amp; Process</h5>
          {nodejs.cpuUsage > 0 && (
            <>
              <div className={styles.metricRow}>
                <span className={styles.metricLabel}>CPU Usage</span>
                <span className={styles.metricValue}>{(nodejs.cpuUsage * 100).toFixed(1)}%</span>
              </div>
              <UtilizationBar value={nodejs.cpuUsage * 100} />
            </>
          )}
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>GC Rate</span>
            <span className={styles.metricValue}>{nodejs.gcRate.toFixed(2)}/s</span>
          </div>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Active Handles</span>
            <span className={styles.metricValue}>{Math.round(nodejs.activeHandles)}</span>
          </div>
          {nodejs.activeRequests > 0 && (
            <div className={styles.metricRow}>
              <span className={styles.metricLabel}>Active Requests</span>
              <span className={styles.metricValue}>{Math.round(nodejs.activeRequests)}</span>
            </div>
          )}
          {nodejs.openFds > 0 && (
            <>
              <div className={styles.metricRow}>
                <span className={styles.metricLabel}>Open FDs</span>
                <span className={styles.metricValue}>
                  {Math.round(nodejs.openFds)}
                  {nodejs.maxFds > 0 && ` / ${Math.round(nodejs.maxFds)}`}
                </span>
              </div>
              {nodejs.maxFds > 0 && <UtilizationBar value={fdPct} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DB Pool Card
// ---------------------------------------------------------------------------

function DBPoolCard({ dbPool }: { dbPool: DBPoolRuntime }) {
  const styles = useStyles2(getStyles);

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <Icon name="database" />
        <span>Database Connection Pools</span>
        <Badge text={`${dbPool.pools.length} pool${dbPool.pools.length !== 1 ? 's' : ''}`} color="orange" />
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>Pool</th>
            <th>Active</th>
            <th>Idle</th>
            <th>Max</th>
            <th>Pending</th>
            <th>Utilization</th>
            <th>Timeouts/s</th>
          </tr>
        </thead>
        <tbody>
          {dbPool.pools.map((pool) => (
            <tr key={pool.name}>
              <td className={styles.nameCell}>
                <Badge text={pool.type} color="orange" />
                <span>{pool.name}</span>
              </td>
              <td className={styles.numCell}>{pool.active.toFixed(1)}</td>
              <td className={styles.numCell}>{pool.idle.toFixed(1)}</td>
              <td className={styles.numCell}>{pool.max}</td>
              <td className={pool.pending > 0 ? styles.warnCell : styles.numCell}>{pool.pending.toFixed(1)}</td>
              <td className={styles.numCell}>
                <UtilizationBar value={pool.utilization} inline />
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

// ---------------------------------------------------------------------------
// Kafka Card
// ---------------------------------------------------------------------------

function KafkaCard({ kafka }: { kafka: KafkaRuntime }) {
  const styles = useStyles2(getStyles);

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <Icon name="exchange-alt" />
        <span>Kafka Consumer</span>
        <Badge text={`${kafka.topics.length} topic${kafka.topics.length !== 1 ? 's' : ''}`} color="purple" />
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>Topic</th>
            <th>Max Lag</th>
            <th>Partitions</th>
            <th>Consume Rate</th>
          </tr>
        </thead>
        <tbody>
          {kafka.topics.map((topic) => (
            <tr key={topic.topic}>
              <td className={styles.nameCell}>
                <span className={styles.mono}>{topic.topic}</span>
              </td>
              <td className={topic.maxLag > 1000 ? styles.warnCell : styles.numCell}>
                {topic.maxLag.toLocaleString()}
              </td>
              <td className={styles.numCell}>{topic.partitions}</td>
              <td className={styles.numCell}>{topic.consumeRate.toFixed(1)} rec/s</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

const THREAD_STATE_COLORS: Record<string, string> = {
  runnable: '#73BF69',
  waiting: '#FF9830',
  'timed-waiting': '#F2CC0C',
  blocked: '#F2495C',
  new: '#8AB8FF',
  terminated: '#999999',
};

function ThreadStateBar({ states }: { states: Record<string, number> }) {
  const styles = useStyles2(getStyles);
  const total = Object.values(states).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return null;
  }

  const entries = Object.entries(states).sort((a, b) => b[1] - a[1]);

  return (
    <div className={styles.threadStateContainer}>
      <div className={styles.threadStateBar}>
        {entries.map(([state, count]) => (
          <div
            key={state}
            title={`${state}: ${count}`}
            style={{
              width: `${(count / total) * 100}%`,
              backgroundColor: THREAD_STATE_COLORS[state] ?? '#999',
              height: '100%',
            }}
          />
        ))}
      </div>
      <div className={styles.threadStateLegend}>
        {entries.map(([state, count]) => (
          <span key={state} className={styles.threadStateItem}>
            <span className={styles.threadStateDot} style={{ backgroundColor: THREAD_STATE_COLORS[state] ?? '#999' }} />
            {state} {count}
          </span>
        ))}
      </div>
    </div>
  );
}

function formatPct(v: number): string {
  if (v === 0) {
    return '0%';
  }
  return v < 1 ? `${v.toFixed(1)}%` : `${v.toFixed(0)}%`;
}

function UtilizationBar({ value, inline }: { value: number; inline?: boolean }) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const fillColor =
    value > 90
      ? theme.colors.error.main
      : value > 70
        ? theme.colors.warning.main
        : theme.colors.success.main;

  if (inline) {
    return (
      <div className={styles.utilInline}>
        <div className={styles.utilBarBg}>
          <div
            className={styles.utilBarFill}
            style={{ width: `${Math.min(value, 100)}%`, backgroundColor: fillColor }}
          />
        </div>
        <span>{formatPct(value)}</span>
      </div>
    );
  }

  return (
    <div className={styles.utilBar}>
      <div className={styles.utilBarBg}>
        <div
          className={styles.utilBarFill}
          style={{ width: `${Math.min(value, 100)}%`, backgroundColor: fillColor }}
        />
      </div>
      <span className={styles.utilLabel}>{formatPct(value)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(val < 10 ? 2 : 1)} ${units[i]}`;
}

function formatMs(seconds: number): string {
  if (seconds === 0) {
    return '0ms';
  }
  const ms = seconds * 1000;
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)}µs`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(ms < 10 ? 2 : 1)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(3)};
  `,
  card: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
    background: ${theme.colors.background.primary};
  `,
  cardHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    margin-bottom: ${theme.spacing(2)};
    color: ${theme.colors.text.primary};
  `,
  metricsGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: ${theme.spacing(3)};
  `,
  metricGroup: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
  `,
  groupTitle: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0 0 ${theme.spacing(0.5)} 0;
  `,
  metricRow: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: ${theme.spacing(0.5)} 0;
  `,
  metricLabel: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.body.fontSize};
  `,
  metricValue: css`
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    font-size: ${theme.typography.body.fontSize};
  `,
  table: css`
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    th {
      text-align: left;
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      color: ${theme.colors.text.secondary};
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      border-bottom: 1px solid ${theme.colors.border.medium};
      white-space: nowrap;
    }
    th:nth-child(n + 2) {
      text-align: right;
    }
    td {
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: middle;
    }
    tr:hover {
      background: ${theme.colors.background.secondary};
    }
  `,
  nameCell: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  numCell: css`
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  `,
  warnCell: css`
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.warning.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  errorCell: css`
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  mono: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  utilBar: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    margin: ${theme.spacing(0.5)} 0;
  `,
  utilInline: css`
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
  warnValue: css`
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.warning.text};
  `,
  uptimeBadge: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-weight: normal;
  `,
  threadStateContainer: css`
    margin: ${theme.spacing(0.5)} 0;
  `,
  threadStateBar: css`
    display: flex;
    height: 8px;
    border-radius: 4px;
    overflow: hidden;
    background: ${theme.colors.background.secondary};
  `,
  threadStateLegend: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(1)};
    margin-top: ${theme.spacing(0.5)};
  `,
  threadStateItem: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: ${theme.colors.text.secondary};
  `,
  threadStateDot: css`
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  `,
});
