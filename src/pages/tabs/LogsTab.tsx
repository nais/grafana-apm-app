import React, { useMemo, useState } from 'react';
import { useStyles2, Select } from '@grafana/ui';
import { SelectableValue, GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { GraphDrawStyle, StackingMode } from '@grafana/schema/dist/types/common/common.gen';
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

export interface LogsTabProps {
  service: string;
  namespace: string;
  logsUid: string;
}

export function LogsTab({ service, namespace, logsUid }: LogsTabProps) {
  const [severityFilter, setSeverityFilter] = useState<string[]>([]);
  const styles = useStyles2(getStyles);

  const severityOptions: Array<SelectableValue<string>> = [
    { label: 'Error', value: 'error' },
    { label: 'Warn', value: 'warn' },
    { label: 'Info', value: 'info' },
    { label: 'Debug', value: 'debug' },
  ];

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from: 'now-1h', to: 'now' });
    const svcMatcher = namespace
      ? `service_name="${service}", service_namespace="${namespace}"`
      : `service_name="${service}"`;
    const severityMatcher = severityFilter.length > 0
      ? ` | level=~"${severityFilter.join('|')}"`
      : '';

    const volumeQuery = new SceneQueryRunner({
      datasource: { uid: logsUid, type: 'loki' },
      queries: [
        {
          refId: 'volume',
          expr: `sum by (level) (count_over_time({${svcMatcher}}${severityMatcher} [$__auto]))`,
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
          expr: `{${svcMatcher}}${severityMatcher}`,
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
              .build(),
          }),
        ],
      }),
    });
  }, [service, namespace, logsUid, severityFilter]);

  return (
    <div>
      <div className={styles.controls}>
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
      <scene.Component model={scene} />
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  controls: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    margin-bottom: ${theme.spacing(2)};
    flex-wrap: wrap;
  `,
  label: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
