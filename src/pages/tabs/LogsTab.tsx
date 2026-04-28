import React, { useEffect, useMemo, useState } from 'react';
import { useStyles2, MultiCombobox, Input, Icon, Switch, Combobox } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { GraphDrawStyle, StackingMode } from '@grafana/schema';
import {
  SceneTimeRange,
  SceneQueryRunner,
  EmbeddedScene,
  SceneFlexLayout,
  SceneFlexItem,
  PanelBuilders,
  SceneTimePicker,
  SceneRefreshPicker,
} from '@grafana/scenes';
import { useDebouncedValue, escapeRegex } from '../../utils/debounce';
import { sanitizeLabelValue } from '../../utils/sanitize';
import { useUrlString, useUrlCsv, useUrlBoolean } from '../../utils/useUrlState';
import { otel } from '../../otelconfig';

interface LogsTabProps {
  service: string;
  namespace: string;
  logsUid: string;
  from: string;
  to: string;
}

// Severity options based on detected_level stream label values observed in production.
// Maps each option to all case variants seen in Loki's detected_level.
const SEVERITY_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'Error', value: 'error' },
  { label: 'Warn', value: 'warn' },
  { label: 'Info', value: 'info' },
  { label: 'Debug', value: 'debug' },
  { label: 'Trace', value: 'trace' },
  { label: 'Unknown', value: 'unknown' },
];

// Faro telemetry kind options — only shown when "Include browser telemetry" is on.
// These correspond to the `kind` stream label values set by the Alloy Faro pipeline.
const FARO_KIND_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'Exceptions', value: 'exception' },
  { label: 'Console Logs', value: 'log' },
  { label: 'Measurements', value: 'measurement' },
  { label: 'Events', value: 'event' },
];

// detected_level values are inconsistently cased across services.
// Map each logical severity to all observed variants.
const SEVERITY_VARIANTS: Record<string, string[]> = {
  error: ['error', 'ERROR', 'SEVERE'],
  warn: ['warn', 'WARN'],
  info: ['info', 'INFO', 'Information'],
  debug: ['debug', 'DEBUG'],
  trace: ['trace', 'TRACE'],
  unknown: ['unknown'],
};

export function LogsTab({ service, namespace, logsUid, from, to }: LogsTabProps) {
  const [severityFilter, setSeverityFilter] = useUrlCsv('logSeverity');
  const [logSearch, setLogSearch] = useUrlString('logSearch');
  const [podFilter, setPodFilter] = useUrlString('logPod');
  const [includeFaro, setIncludeFaro] = useUrlBoolean('includeFaro');
  const [kindFilter, setKindFilter] = useUrlCsv('kindFilter');
  const [podOptions, setPodOptions] = useState<Array<{ label: string; value: string }>>([]);
  const debouncedSearch = useDebouncedValue(logSearch, 500);
  const styles = useStyles2(getStyles);

  // Fetch available pod names for this service
  useEffect(() => {
    const controller = new AbortController();
    fetch(
      `/api/datasources/proxy/uid/${encodeURIComponent(logsUid)}/loki/api/v1/label/k8s_pod_name/values?query=${encodeURIComponent(`{${otel.labels.serviceName}="${sanitizeLabelValue(service)}"}`)}`,
      { signal: controller.signal }
    )
      .then((r) => r.json())
      .then((d: { data?: string[] }) => {
        const pods = (d.data ?? []).filter((p) => p.length > 0).sort();
        setPodOptions(pods.map((p) => ({ label: p, value: p })));
      })
      .catch(() => {
        /* ignore */
      });
    return () => controller.abort();
  }, [service, logsUid]);

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from, to });
    const svcLabel = `${otel.labels.serviceName}="${sanitizeLabelValue(service)}"`;

    // Faro browser telemetry filtering via the `kind` stream label:
    // - Off: kind="" matches only backend app logs (no kind label)
    // - On + no filter: show all (no kind constraint)
    // - On + specific kinds: kind=~"exception|log" for selected types
    let kindStream = ', kind=""';
    if (includeFaro) {
      if (kindFilter.length > 0) {
        kindStream = `, kind=~"${kindFilter.join('|')}"`;
      } else {
        kindStream = '';
      }
    }

    // Pod filtering uses k8s_pod_name stream label (only present on backend log streams).
    const podStream = podFilter ? `, k8s_pod_name="${sanitizeLabelValue(podFilter)}"` : '';

    const streamSelector = `{${svcLabel}${kindStream}${podStream}}`;

    // Severity filtering uses pipeline-level JSON parsing because `detected_level` is
    // structured metadata in Loki, not an indexed stream label — it can't be used in
    // stream selectors. We parse JSON and filter on the `level` field instead.
    const severityValues = severityFilter.flatMap((s) => SEVERITY_VARIANTS[s] ?? [s]);
    const severityLabelFilter = severityValues.length > 0 ? ` | level=~"${severityValues.join('|')}"` : '';
    // Volume query needs its own json parser since it has no other parser stage.
    const severityPipeline = severityValues.length > 0 ? ` | json${severityLabelFilter}` : '';

    const textFilter = debouncedSearch ? ` |~ "${escapeRegex(debouncedSearch)}"` : '';

    const volumeQuery = new SceneQueryRunner({
      datasource: { uid: logsUid, type: 'loki' },
      queries: [
        {
          refId: 'volume',
          expr: `sum by (detected_level) (count_over_time(${streamSelector}${textFilter}${severityPipeline} [$__auto]))`,
          legendFormat: '{{detected_level}}',
          queryType: 'range',
        },
      ],
    });

    const logQuery = new SceneQueryRunner({
      datasource: { uid: logsUid, type: 'loki' },
      queries: [
        {
          refId: 'A',
          expr: `${streamSelector}${textFilter} | json${severityLabelFilter} | line_format \`{{ if .message }}{{ .message }}{{ else if .msg }}{{ .msg }}{{ else }}{{ __line__ }}{{ end }}\` | drop __error__, __error_details__`,
          queryType: 'range',
          maxLines: 200,
        },
      ],
    });

    return new EmbeddedScene({
      $timeRange: timeRange,
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          new SceneFlexItem({
            minHeight: 120,
            maxHeight: 180,
            body: PanelBuilders.timeseries()
              .setTitle('Log volume')
              .setData(volumeQuery)
              .setCustomFieldConfig('stacking', { mode: StackingMode.Normal })
              .setCustomFieldConfig('fillOpacity', 80)
              .setCustomFieldConfig('lineWidth', 0)
              .setCustomFieldConfig('drawStyle', GraphDrawStyle.Bars)
              .build(),
          }),
          new SceneFlexItem({
            minHeight: 400,
            body: PanelBuilders.logs()
              .setTitle(`Logs — ${service}`)
              .setData(logQuery)
              .setOption('enableLogDetails', true)
              .setOption('showTime', true)
              .setOption('wrapLogMessage', true)
              .setOption('prettifyLogMessage', false)
              .setOption('showLabels', false)
              .setOption('showCommonLabels', false)
              .build(),
          }),
        ],
      }),
    });
  }, [service, logsUid, severityFilter, debouncedSearch, podFilter, includeFaro, kindFilter, from, to]);

  return (
    <div className={styles.wrapper}>
      <div className={styles.controls}>
        <Input
          prefix={<Icon name="search" />}
          placeholder="Search logs..."
          width={24}
          value={logSearch}
          onChange={(e) => setLogSearch(e.currentTarget.value)}
        />
        <label className={styles.label}>Severity:</label>
        <MultiCombobox
          options={SEVERITY_OPTIONS}
          value={severityFilter}
          onChange={(v) => setSeverityFilter(v.map((o) => o.value))}
          width={30}
          placeholder="All severities"
        />
        {podOptions.length > 1 && (
          <>
            <label className={styles.label}>Pod:</label>
            <Combobox
              options={[{ label: 'All pods', value: '' }, ...podOptions]}
              value={podFilter}
              onChange={(v) => setPodFilter(v?.value ?? '')}
              width={36}
              placeholder="All pods"
            />
          </>
        )}
        <label className={styles.toggle}>
          <Switch value={includeFaro} onChange={() => setIncludeFaro(!includeFaro)} />
          <span>Include browser telemetry</span>
        </label>
        {includeFaro && (
          <>
            <label className={styles.label}>Kind:</label>
            <MultiCombobox
              options={FARO_KIND_OPTIONS}
              value={kindFilter}
              onChange={(v) => setKindFilter(v.map((o) => o.value))}
              width={28}
              placeholder="All kinds"
            />
          </>
        )}
      </div>
      <div className={styles.sceneWrapper}>
        <scene.Component model={scene} />
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  `,
  controls: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    margin-bottom: ${theme.spacing(2)};
    flex-wrap: wrap;
  `,
  sceneWrapper: css`
    flex: 1;
    min-height: 0;
    overflow: auto;
  `,
  label: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  toggle: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    cursor: pointer;
    margin-left: ${theme.spacing(0.5)};
  `,
});
