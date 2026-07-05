import React, { useState } from 'react';
import { CollapsibleSection } from '../../../components/CollapsibleSection';
import { Button, Combobox, Tooltip, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getTraceBreakdown } from '../../../api/analytics';
import { useFetch } from '../../../utils/useFetch';
import { DataState } from '../../../components/DataState';
import { formatDuration, formatRate, formatErrorRate } from '../../../utils/format';

/** Rows shown before the "show all" affordance reveals the rest (rule 5: keep the panel compact even expanded). */
const TOP_N = 6;

interface TraceBreakdownsProps {
  namespace: string;
  service: string;
  tracesUid: string;
  fromMs: number;
  toMs: number;
  /** Feed a value into the traces span-search filter. */
  onSelectSpan: (value: string) => void;
}

/** Display labels for the curated dimensions. */
const DIMENSION_LABELS: Record<string, string> = {
  name: 'Span name',
  'http.route': 'HTTP route',
  'http.status_code': 'HTTP status',
  'db.system': 'DB system',
  'db.operation': 'DB operation',
  'messaging.system': 'Messaging',
  'rpc.method': 'RPC method',
};

const MODE_LABEL: Record<string, string> = {
  traceql: 'TraceQL metrics',
  spanmetrics: 'span metrics',
  unavailable: 'unavailable',
};

/**
 * Per-dimension RED breakdown of a service's spans (M6). Tempo TraceQL metrics
 * group by an attribute (span name, db.system, …) and report rate, error rate,
 * and latency percentiles. The dimension picker only offers attributes that
 * actually carry data. Row click seeds the span search below.
 *
 * Collapsed by default (ia-review-2 rule 5: the trace list, not this summary,
 * is the primary object on this tab) — the collapse header always shows the
 * current group-by dimension and row count so the signal survives collapse.
 * Expanded rows are capped to TOP_N with a "show all" affordance so a wide
 * breakdown still doesn't dominate the tab.
 */
export function TraceBreakdowns({ namespace, service, tracesUid, fromMs, toMs, onSelectSpan }: TraceBreakdownsProps) {
  const styles = useStyles2(getStyles);
  const [dimension, setDimension] = useState('name');
  const [showAll, setShowAll] = useState(false);

  const { data, loading, error } = useFetch(
    () => getTraceBreakdown(namespace, service, fromMs, toMs, tracesUid, dimension),
    [namespace, service, fromMs, toMs, tracesUid, dimension],
    { skip: !tracesUid }
  );

  // A new dimension or time window is a new dataset — start from the top-N view again.
  // Adjusting state during render (rather than in an effect) avoids the extra
  // render-then-effect-then-render cascade; see https://react.dev/learn/you-might-not-need-an-effect.
  const datasetKey = `${dimension}|${fromMs}|${toMs}`;
  const [prevDatasetKey, setPrevDatasetKey] = useState(datasetKey);
  if (datasetKey !== prevDatasetKey) {
    setPrevDatasetKey(datasetKey);
    setShowAll(false);
  }

  const rows = data?.rows ?? [];
  const visibleRows = showAll ? rows : rows.slice(0, TOP_N);
  const maxRate = rows.reduce((m, r) => Math.max(m, r.rate), 0) || 1;
  const maxP99 = rows.reduce((m, r) => Math.max(m, r.p99Ms), 0) || 1;

  const availableDims = data?.dimensions?.length ? data.dimensions : ['name'];
  const dimensionOptions = availableDims.map((d) => ({ label: DIMENSION_LABELS[d] ?? d, value: d }));

  const collapsedLabel = `Breakdowns by ${dimension}${rows.length ? ` (${rows.length})` : ''}`;

  return (
    <CollapsibleSection label={collapsedLabel} className={styles.collapse}>
      <div className={styles.header}>
        <label id="trace-breakdown-groupby" className={styles.label}>
          Group by:
        </label>
        <Combobox
          aria-labelledby="trace-breakdown-groupby"
          options={dimensionOptions}
          value={dimension}
          onChange={(v) => setDimension(v?.value ?? 'name')}
          width={22}
        />
        {data && data.mode !== 'unavailable' && (
          <Tooltip content={data.note || 'Metric source.'}>
            <span className={styles.modeBadge}>{MODE_LABEL[data.mode] ?? data.mode}</span>
          </Tooltip>
        )}
      </div>
      <DataState
        loading={loading}
        error={
          error
            ? 'Failed to load breakdown'
            : data?.mode === 'unavailable'
              ? data.note || 'Breakdown unavailable'
              : null
        }
        empty={rows.length === 0}
        loadingText="Loading breakdown…"
        emptyTitle="No data"
        emptyMessage="No spans for this dimension in the selected time range."
      >
        <table className={styles.table} aria-label="Span breakdown">
          <thead>
            <tr>
              <th scope="col">{DIMENSION_LABELS[dimension] ?? dimension}</th>
              <th scope="col" className={styles.num}>
                Rate
              </th>
              <th scope="col" className={styles.num}>
                Error %
              </th>
              <th scope="col" className={styles.num}>
                P95
              </th>
              <th scope="col" className={styles.num}>
                P99
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <tr
                key={r.value}
                className={styles.row}
                role="button"
                tabIndex={0}
                onClick={() => onSelectSpan(r.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectSpan(r.value);
                  }
                }}
                title={`Search traces for "${r.value}"`}
              >
                <td className={styles.valueCell} title={r.value}>
                  {r.value}
                </td>
                <td className={styles.num}>
                  <div className={styles.barCell}>
                    <span>{formatRate(r.rate)}</span>
                    <div className={styles.bar} style={{ width: `${(r.rate / maxRate) * 100}%` }} />
                  </div>
                </td>
                <td className={`${styles.num} ${r.errorRate > 0 ? styles.errorText : ''}`}>
                  {formatErrorRate(r.errorRate)}
                </td>
                <td className={styles.num}>{formatDuration(r.p95Ms, 'ms')}</td>
                <td className={styles.num}>
                  <div className={styles.barCell}>
                    <span>{formatDuration(r.p99Ms, 'ms')}</span>
                    <div className={styles.barLatency} style={{ width: `${(r.p99Ms / maxP99) * 100}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > TOP_N && (
          <Button
            size="sm"
            variant="secondary"
            fill="text"
            className={styles.showAllButton}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? `Show top ${TOP_N}` : `Show all ${rows.length}`}
          </Button>
        )}
      </DataState>
    </CollapsibleSection>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  collapse: css`
    margin-bottom: ${theme.spacing(2)};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.5, 1)};
  `,
  showAllButton: css`
    margin-top: ${theme.spacing(0.5)};
  `,
  label: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  modeBadge: css`
    margin-left: auto;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(0, 0.75)};
    white-space: nowrap;
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
      vertical-align: middle;
    }
  `,
  row: css`
    cursor: pointer;
    &:hover {
      background: ${theme.colors.action.hover};
    }
    &:focus-visible {
      outline: 2px solid ${theme.colors.primary.border};
      outline-offset: -2px;
    }
  `,
  valueCell: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  num: css`
    text-align: right;
    white-space: nowrap;
    width: 1%;
    font-variant-numeric: tabular-nums;
  `,
  errorText: css`
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  barCell: css`
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
  `,
  bar: css`
    height: 3px;
    width: 100%;
    background: ${theme.colors.primary.main};
    opacity: 0.5;
    border-radius: 2px;
  `,
  barLatency: css`
    height: 3px;
    width: 100%;
    background: ${theme.colors.warning.main};
    opacity: 0.5;
    border-radius: 2px;
  `,
});
