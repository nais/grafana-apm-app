import React from 'react';
import { useStyles2, ControlledCollapse } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { ServerTab } from './ServerTab';
import { RuntimeTab } from './RuntimeTab';

interface BackendTabProps {
  service: string;
  namespace: string;
  fromMs: number;
  toMs: number;
  environment?: string;
  onViewTraces?: (spanName: string, status?: string) => void;
}

/**
 * Backend tab — answers "the server side of my service": is the workload
 * healthy, and if not, is it the workload (RED — rate/errors/duration per
 * operation) or the resources (USE — CPU/memory/GC/pool saturation)?
 *
 * Merges the former standalone Endpoints and Runtime tabs into one tab with
 * two clearly-labeled sections, ordered symptom → cause (docs/ia-review-2.md,
 * rules 1/2/4). Reuses ServerTab and RuntimeTab verbatim — no panel logic is
 * reimplemented here, this component only adds section chrome around them.
 *
 * Endpoints is always expanded (it's the primary reason someone opens this
 * tab). Runtime is collapsed by default (rule 6: content-gate rather than
 * clutter when resources look nominal). This v1 always collapses regardless
 * of the actual data — a later refinement could auto-expand when resources
 * are genuinely saturated (CPU/mem/GC/pool thresholds), but that health
 * detection is deliberately not built yet to avoid over-engineering; tracked
 * as a follow-up.
 */
export function BackendTab({ service, namespace, fromMs, toMs, environment, onViewTraces }: BackendTabProps) {
  const styles = useStyles2(getStyles);

  return (
    <div className={styles.container}>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Endpoints</h3>
          <span className={styles.sectionSubtitle}>RED — rate, errors, duration per operation</span>
        </div>
        <ServerTab
          service={service}
          namespace={namespace}
          fromMs={fromMs}
          toMs={toMs}
          environment={environment}
          onViewTraces={onViewTraces}
        />
      </section>

      <section className={styles.section}>
        <ControlledCollapse label="Runtime — process resources" isOpen={false}>
          <RuntimeTab service={service} namespace={namespace} environment={environment} fromMs={fromMs} toMs={toMs} />
        </ControlledCollapse>
      </section>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(4)};
  `,
  section: css`
    display: flex;
    flex-direction: column;
  `,
  sectionHeader: css`
    display: flex;
    align-items: baseline;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(2)};
  `,
  sectionTitle: css`
    margin: 0;
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
  `,
  sectionSubtitle: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
