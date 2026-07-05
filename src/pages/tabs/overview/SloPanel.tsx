import React, { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getAppEvents, locationService } from '@grafana/runtime';
import { AppEvents, GrafanaTheme2 } from '@grafana/data';
import { Button, Icon, LoadingPlaceholder, RadioButtonGroup, TextLink, Tooltip, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';
import { buildAlertRuleUrl } from '../../../api/client';
import { apmDocs } from '../../../utils/docsLinks';
import { useFetch } from '../../../utils/useFetch';
import { useCapabilities, getMetricNames } from '../../../utils/capabilities';
import { usePluginDatasources } from '../../../utils/datasources';
import {
  BurnWindow,
  DEFAULT_SLO_TARGET,
  SLO_TARGETS,
  SloComputed,
  computeSlo,
  fetchSloBurnTemplateUrl,
  fetchSloMetrics,
  formatSloTarget,
  sloSelector,
} from './sloData';

interface SloPanelProps {
  namespace: string;
  service: string;
  environment?: string;
}

const TARGET_OPTIONS = SLO_TARGETS.map((t) => ({ label: formatSloTarget(t), value: t }));

/** Parse the `slo` URL param into a known target, defaulting to 99.9%. */
function parseTargetParam(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw);
  return (SLO_TARGETS as readonly number[]).includes(n) ? n : DEFAULT_SLO_TARGET;
}

/**
 * Error-budget panel (M7): the OSS-niche answer to Cloud-only managed SLOs.
 * Computes 30d compliance, remaining error budget (with a color bar) and the
 * current 1h burn rate off the RED error ratio — all client-side from instant
 * queries so the target selector re-computes with no refetch — and offers the
 * two multi-window burn-rate alert rules (Google SRE fast/slow) pre-filled
 * through the existing alert-template flow.
 */
export function SloPanel({ namespace, service, environment }: SloPanelProps) {
  const styles = useStyles2(getStyles);
  const [searchParams, setSearchParams] = useSearchParams();
  const target = parseTargetParam(searchParams.get('slo'));

  const { caps } = useCapabilities();
  const { callsMetric } = getMetricNames(caps);
  const { metricsUid } = usePluginDatasources(environment);

  const selector = useMemo(() => sloSelector(service, namespace, environment), [service, namespace, environment]);

  const { data, loading, error } = useFetch(
    () => fetchSloMetrics(metricsUid, callsMetric, selector),
    [metricsUid, callsMetric, selector],
    { skip: !metricsUid || !callsMetric }
  );

  const computed: SloComputed | null = useMemo(() => (data ? computeSlo(data, target) : null), [data, target]);

  const setTarget = useCallback(
    (value: number) => {
      const next = new URLSearchParams(searchParams);
      next.set('slo', String(value));
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const [creating, setCreating] = useState<BurnWindow | null>(null);
  const createAlert = useCallback(
    async (window: BurnWindow) => {
      setCreating(window);
      try {
        const url = await fetchSloBurnTemplateUrl({
          namespace: namespace || undefined,
          service,
          environment: environment || undefined,
          target,
          window,
        });
        locationService.push(buildAlertRuleUrl(url));
      } catch (err) {
        setCreating(null);
        getAppEvents().publish({
          type: AppEvents.alertError.name,
          payload: ['Could not prepare burn-rate alert', err instanceof Error ? err.message : String(err)],
        });
      }
    },
    [namespace, service, environment, target]
  );

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <h3 className={styles.title}>Error budget</h3>
          <span className={styles.subtitle}>30-day compliance against the SLO target</span>
        </div>
        <div className={styles.targetGroup}>
          <span className={styles.targetLabel}>SLO target</span>
          <RadioButtonGroup
            aria-label="SLO target"
            size="sm"
            options={TARGET_OPTIONS}
            value={target}
            onChange={setTarget}
          />
        </div>
      </div>

      {loading && !data ? (
        <LoadingPlaceholder text="Computing error budget…" />
      ) : error ? (
        <div className={styles.message}>Could not compute the error budget from span metrics.</div>
      ) : computed ? (
        <>
          <SloTiles computed={computed} styles={styles} />
          <div className={styles.actions}>
            <span className={styles.actionsLabel}>Create burn-rate alerts:</span>
            <Button
              size="sm"
              variant="secondary"
              icon="bell"
              disabled={creating !== null}
              onClick={() => createAlert('fast')}
            >
              Fast burn (page)
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="bell"
              disabled={creating !== null}
              onClick={() => createAlert('slow')}
            >
              Slow burn (ticket)
            </Button>
            <Tooltip content="Multi-window multi-burn-rate rules (Google SRE): fast burn = 14.4× budget over 1h & 5m, slow burn = 6× over 6h & 30m.">
              <Icon name="info-circle" className={styles.infoIcon} aria-label="About burn-rate alert windows" />
            </Tooltip>
            <TextLink href={apmDocs.createAlerts()} external variant="bodySmall" className={styles.docsLink}>
              About alert templates
            </TextLink>
          </div>
        </>
      ) : null}
    </div>
  );
}

const STATUS_CLASS: Record<SloComputed['status'], (s: ReturnType<typeof getStyles>) => string> = {
  healthy: (s) => s.barHealthy,
  warning: (s) => s.barWarning,
  critical: (s) => s.barCritical,
  unknown: (s) => s.barUnknown,
};

function SloTiles({ computed, styles }: { computed: SloComputed; styles: ReturnType<typeof getStyles> }) {
  const barClass = STATUS_CLASS[computed.status](styles);
  const barWidth = computed.budgetRemainingPct === null ? 0 : Math.max(0, Math.min(100, computed.budgetRemainingPct));

  return (
    <div className={styles.tiles}>
      <div className={styles.tile}>
        <span className={styles.tileLabel}>30d compliance</span>
        {computed.enoughData && computed.compliancePct !== null ? (
          <span className={styles.tileValue}>{formatPct(computed.compliancePct, 3)}</span>
        ) : (
          <span className={styles.notEnough}>Not enough data</span>
        )}
      </div>

      <div className={styles.tile}>
        <span className={styles.tileLabel}>Budget remaining</span>
        {computed.enoughData && computed.budgetRemainingPct !== null ? (
          <>
            <span className={styles.tileValue}>{formatPct(computed.budgetRemainingPct, 0)}</span>
            <div className={styles.barTrack} role="img" aria-label={`Error budget status: ${computed.status}`}>
              <div className={`${styles.barFill} ${barClass}`} style={{ width: `${barWidth}%` }} />
            </div>
          </>
        ) : (
          <span className={styles.notEnough}>Not enough data</span>
        )}
      </div>

      <div className={styles.tile}>
        <span className={styles.tileLabel}>Burn rate (1h)</span>
        {computed.burnRate1h !== null ? (
          <span className={styles.tileValue}>
            {formatBurn(computed.burnRate1h)}
            <span className={styles.burnHint}> × budget</span>
          </span>
        ) : (
          <span className={styles.notEnough}>—</span>
        )}
      </div>
    </div>
  );
}

function formatPct(value: number, decimals: number): string {
  return `${value.toFixed(decimals)}%`;
}

function formatBurn(value: number): string {
  if (value >= 100) {
    return value.toFixed(0);
  }
  if (value >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

const getStyles = (theme: GrafanaTheme2) => ({
  panel: css`
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1.5)} ${theme.spacing(2)};
    margin-bottom: ${theme.spacing(2)};
  `,
  header: css`
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: ${theme.spacing(2)};
    margin-bottom: ${theme.spacing(1.5)};
    flex-wrap: wrap;
  `,
  titleGroup: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.25)};
  `,
  title: css`
    margin: 0;
    font-size: ${theme.typography.h5.fontSize};
  `,
  subtitle: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  targetGroup: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  targetLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `,
  tiles: css`
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: ${theme.spacing(2)};
    @media (max-width: 768px) {
      grid-template-columns: 1fr;
    }
  `,
  tile: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
  `,
  tileLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `,
  tileValue: css`
    font-size: ${theme.typography.h2.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
  `,
  burnHint: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-weight: ${theme.typography.fontWeightRegular};
  `,
  notEnough: css`
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  barTrack: css`
    width: 100%;
    height: 8px;
    border-radius: ${theme.shape.radius.pill};
    background: ${theme.colors.background.secondary};
    overflow: hidden;
  `,
  barFill: css`
    height: 100%;
    border-radius: ${theme.shape.radius.pill};
    transition: width 0.3s ease;
  `,
  barHealthy: css`
    background: ${theme.colors.success.main};
  `,
  barWarning: css`
    background: ${theme.colors.warning.main};
  `,
  barCritical: css`
    background: ${theme.colors.error.main};
  `,
  barUnknown: css`
    background: ${theme.colors.border.strong};
  `,
  actions: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    margin-top: ${theme.spacing(2)};
    flex-wrap: wrap;
  `,
  actionsLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  infoIcon: css`
    color: ${theme.colors.text.secondary};
  `,
  docsLink: css`
    margin-left: auto;
    white-space: nowrap;
  `,
  message: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
