import React, { useMemo, useState } from 'react';
import { useStyles2, Select } from '@grafana/ui';
import { SelectableValue, GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
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

export interface TracesTabProps {
  service: string;
  namespace: string;
  tracesUid: string;
}

export function TracesTab({ service, namespace, tracesUid }: TracesTabProps) {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [durationMin, setDurationMin] = useState<string>('');
  const [durationMax, setDurationMax] = useState<string>('');
  const styles = useStyles2(getStyles);

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from: 'now-1h', to: 'now' });

    const conditions: string[] = [`resource.service.name="${service}"`];
    if (namespace) {
      conditions.push(`resource.service.namespace="${namespace}"`);
    }
    if (statusFilter === 'error') {
      conditions.push(`status=error`);
    } else if (statusFilter === 'ok') {
      conditions.push(`status=ok`);
    }
    let traceQL = `{${conditions.join(' && ')}}`;
    if (durationMin) {
      traceQL += ` | duration >= ${durationMin}ms`;
    }
    if (durationMax) {
      traceQL += ` | duration <= ${durationMax}ms`;
    }

    const traceQuery = new SceneQueryRunner({
      datasource: { uid: tracesUid, type: 'tempo' },
      queries: [
        {
          refId: 'A',
          queryType: 'traceql',
          query: traceQL,
          tableType: 'traces',
          limit: 20,
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
            minHeight: 400,
            body: PanelBuilders.table()
              .setTitle(`Traces — ${service}`)
              .setData(traceQuery)
              .build(),
          }),
        ],
      }),
    });
  }, [service, namespace, tracesUid, statusFilter, durationMin, durationMax]);

  const statusOptions: Array<SelectableValue<string>> = [
    { label: 'All', value: '' },
    { label: 'Error', value: 'error' },
    { label: 'OK', value: 'ok' },
  ];

  return (
    <div>
      <div className={styles.controls}>
        <label className={styles.label}>Status:</label>
        <Select
          options={statusOptions}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v.value ?? '')}
          width={12}
        />
        <label className={styles.label}>Min duration (ms):</label>
        <input
          className={styles.durationInput}
          type="number"
          placeholder="0"
          value={durationMin}
          onChange={(e) => setDurationMin(e.target.value)}
        />
        <label className={styles.label}>Max duration (ms):</label>
        <input
          className={styles.durationInput}
          type="number"
          placeholder="∞"
          value={durationMax}
          onChange={(e) => setDurationMax(e.target.value)}
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
  durationInput: css`
    width: 80px;
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
