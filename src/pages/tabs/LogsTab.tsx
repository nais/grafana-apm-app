import React, { useMemo, useState } from 'react';
import { useStyles2, Select, Input, Icon } from '@grafana/ui';
import { SelectableValue, GrafanaTheme2 } from '@grafana/data';
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
import { otel } from '../../otelconfig';

export interface LogsTabProps {
  service: string;
  namespace: string;
  logsUid: string;
}

export function LogsTab({ service, namespace, logsUid }: LogsTabProps) {
  const [severityFilter, setSeverityFilter] = useState<string[]>([]);
  const [logSearch, setLogSearch] = useState<string>('');
  const debouncedSearch = useDebouncedValue(logSearch, 500);
  const styles = useStyles2(getStyles);

  const severityOptions: Array<SelectableValue<string>> = [
    { label: 'Error', value: 'error' },
    { label: 'Warn', value: 'warn' },
    { label: 'Info', value: 'info' },
    { label: 'Debug', value: 'debug' },
  ];

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from: 'now-1h', to: 'now' });
    // Note: service_namespace may differ between signals (e.g., span metrics
    // report "opentelemetry-demo" while logs report "demo"). Only filter by
    // service_name for reliability; namespace scoping is handled at the backend API level.
    const svcMatcher = `${otel.labels.serviceName}="${sanitizeLabelValue(service)}"`;
    const severityMatcher = severityFilter.length > 0 ? ` | level=~"${severityFilter.join('|')}"` : '';
    const textFilter = debouncedSearch ? ` |~ "${escapeRegex(debouncedSearch)}"` : '';

    const volumeQuery = new SceneQueryRunner({
      datasource: { uid: logsUid, type: 'loki' },
      queries: [
        {
          refId: 'volume',
          expr: `sum by (level) (count_over_time({${svcMatcher}}${severityMatcher}${textFilter} [$__auto]))`,
          legendFormat: '{{level}}',
          queryType: 'range',
        },
      ],
    });

    const logQuery = new SceneQueryRunner({
      datasource: { uid: logsUid, type: 'loki' },
      queries: [
        {
          refId: 'A',
          expr: `{${svcMatcher}}${severityMatcher}${textFilter} | json | line_format "{{.message}}"`,
          queryType: 'range',
          maxLines: 100,
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
  }, [service, logsUid, severityFilter, debouncedSearch]);

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
        <Select
          isMulti
          options={severityOptions}
          value={severityFilter.map((v) => severityOptions.find((o) => o.value === v)!)}
          onChange={(v) => setSeverityFilter(v ? (v as Array<SelectableValue<string>>).map((o) => o.value ?? '') : [])}
          width={30}
          placeholder="All severities"
        />
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
});
