import React, { useState } from 'react';
import { CollapsibleSection } from '../../../components/CollapsibleSection';
import { Badge, Button, Icon, TextLink, Tooltip, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getLogPatterns, LogPatternsMode } from '../../../api/analytics';
import { apmDocs } from '../../../utils/docsLinks';
import { useFetch } from '../../../utils/useFetch';
import { DataState } from '../../../components/DataState';

/** Patterns shown before the "show all" affordance reveals the rest (rule 5: keep the panel compact even expanded). */
const TOP_N = 6;

interface PatternsPanelProps {
  namespace: string;
  service: string;
  logsUid: string;
  fromMs: number;
  toMs: number;
  /** Apply a pattern's search literal to the log panel's existing search filter. */
  onSelectFilter: (literal: string) => void;
}

/** Human label for the pattern provenance badge. */
const MODE_LABEL: Record<LogPatternsMode, string> = {
  serverPatterns: 'server patterns',
  sampled: 'sampled from newest 1000 error lines',
  unavailable: 'unavailable',
};

/**
 * Top error-log patterns for a service (M6). Loki's pattern ingester clusters
 * error lines into `<_>`-templated groups; this surfaces the loudest ones with
 * a count bar and a NEW badge for patterns that only started in this window.
 * Clicking a row seeds the log search with the pattern's most distinctive
 * token so the log panel below filters to matching lines.
 *
 * Collapsed by default (ia-review-2 rule 5: the log list, not this summary,
 * is the primary object on this tab) — the collapse header always shows the
 * pattern count so the signal survives collapse. Expanded rows are capped to
 * TOP_N with a "show all" affordance so a noisy pattern table still doesn't
 * dominate the tab.
 */
export function PatternsPanel({ namespace, service, logsUid, fromMs, toMs, onSelectFilter }: PatternsPanelProps) {
  const styles = useStyles2(getStyles);
  const [showAll, setShowAll] = useState(false);

  const { data, loading, error } = useFetch(
    () => getLogPatterns(namespace, service, fromMs, toMs, logsUid),
    [namespace, service, fromMs, toMs, logsUid],
    { skip: !logsUid }
  );

  // A new time window is a new dataset — start from the top-N view again.
  // Adjusting state during render (rather than in an effect) avoids the extra
  // render-then-effect-then-render cascade; see https://react.dev/learn/you-might-not-need-an-effect.
  const datasetKey = `${fromMs}|${toMs}`;
  const [prevDatasetKey, setPrevDatasetKey] = useState(datasetKey);
  if (datasetKey !== prevDatasetKey) {
    setPrevDatasetKey(datasetKey);
    setShowAll(false);
  }

  const patterns = data?.patterns ?? [];
  const visiblePatterns = showAll ? patterns : patterns.slice(0, TOP_N);
  const maxCount = patterns.reduce((m, p) => Math.max(m, p.count), 0) || 1;

  const collapsedLabel = `Top error patterns${patterns.length ? ` (${patterns.length})` : ''}`;

  return (
    <CollapsibleSection label={collapsedLabel} className={styles.collapse}>
      <div className={styles.header}>
        {data && data.mode !== 'unavailable' && (
          <Tooltip content="How these patterns were produced.">
            <span className={styles.modeBadge}>{MODE_LABEL[data.mode]}</span>
          </Tooltip>
        )}
        <span className={styles.subtitle}>Click a pattern to filter the logs below</span>
        <TextLink href={apmDocs.logPatterns()} external variant="bodySmall" className={styles.docsLink}>
          About log patterns
        </TextLink>
      </div>
      <DataState
        loading={loading}
        error={
          error ? 'Failed to load patterns' : data?.mode === 'unavailable' ? data.note || 'Patterns unavailable' : null
        }
        empty={patterns.length === 0}
        loadingText="Loading patterns…"
        emptyTitle="No error patterns"
        emptyMessage={data?.note || 'No error log patterns in the selected time range.'}
      >
        <ul className={styles.list}>
          {visiblePatterns.map((p, i) => {
            const clickable = !!p.filterLiteral;
            const apply = () => clickable && onSelectFilter(p.filterLiteral);
            return (
              <li
                key={`${p.pattern}-${i}`}
                className={clickable ? styles.rowClickable : styles.row}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={apply}
                onKeyDown={(e) => {
                  if (clickable && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    apply();
                  }
                }}
                title={clickable ? `Filter logs by "${p.filterLiteral}"` : p.pattern}
              >
                <div className={styles.bar} style={{ width: `${Math.max(2, (p.count / maxCount) * 100)}%` }} />
                <div className={styles.rowContent}>
                  <span className={styles.pattern}>{p.pattern}</span>
                  {p.isNew && <Badge text="NEW" color="orange" className={styles.newBadge} />}
                  {clickable && <Icon name="search" className={styles.searchIcon} />}
                </div>
                <span className={styles.count}>{p.count.toLocaleString()}</span>
              </li>
            );
          })}
        </ul>
        {patterns.length > TOP_N && (
          <Button
            size="sm"
            variant="secondary"
            fill="text"
            className={styles.showAllButton}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? `Show top ${TOP_N}` : `Show all ${patterns.length}`}
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
  modeBadge: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(0, 0.75)};
    white-space: nowrap;
  `,
  subtitle: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    margin-left: auto;
  `,
  docsLink: css`
    white-space: nowrap;
  `,
  list: css`
    list-style: none;
    margin: 0;
    padding: 0;
  `,
  row: css`
    position: relative;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.75, 1)};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  rowClickable: css`
    position: relative;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.75, 1)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    cursor: pointer;
    &:hover {
      background: ${theme.colors.action.hover};
    }
    &:focus-visible {
      outline: 2px solid ${theme.colors.primary.border};
      outline-offset: -2px;
    }
  `,
  bar: css`
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: ${theme.colors.error.transparent};
    border-radius: ${theme.shape.radius.default};
    pointer-events: none;
  `,
  rowContent: css`
    position: relative;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    flex: 1;
    min-width: 0;
  `,
  pattern: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  newBadge: css`
    flex-shrink: 0;
  `,
  searchIcon: css`
    color: ${theme.colors.text.secondary};
    flex-shrink: 0;
  `,
  count: css`
    position: relative;
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
  `,
});
