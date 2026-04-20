import React, { useMemo, useState } from 'react';
import { useStyles2, Select, Input, Icon } from '@grafana/ui';
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
import { useDebouncedValue, escapeRegex } from '../../utils/debounce';

interface TracesTabProps {
  service: string;
  namespace: string;
  tracesUid: string;
}

export function TracesTab({ service, namespace, tracesUid }: TracesTabProps) {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [durationMin, setDurationMin] = useState<string>('');
  const [durationMax, setDurationMax] = useState<string>('');
  const [spanSearch, setSpanSearch] = useState<string>('');
  const debouncedSearch = useDebouncedValue(spanSearch, 500);
  const styles = useStyles2(getStyles);

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from: 'now-1h', to: 'now' });

    // Note: resource.service.namespace may differ between signals (e.g., span metrics
    // report "opentelemetry-demo" while traces/logs report "demo"). Only filter by
    // service.name for reliability; namespace scoping is handled at the backend API level.
    const conditions: string[] = [`resource.service.name="${service}"`];
    if (statusFilter === 'error') {
      conditions.push(`status=error`);
    } else if (statusFilter === 'ok') {
      conditions.push(`status=ok`);
    }
    if (debouncedSearch) {
      conditions.push(`name=~".*${escapeRegex(debouncedSearch)}.*"`);
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
            body: PanelBuilders.table().setTitle(`Traces — ${service}`).setData(traceQuery).build(),
          }),
        ],
      }),
    });
  }, [service, tracesUid, statusFilter, durationMin, durationMax, debouncedSearch]);

  const statusOptions: Array<SelectableValue<string>> = [
    { label: 'All', value: '' },
    { label: 'Error', value: 'error' },
    { label: 'OK', value: 'ok' },
  ];

  return (
    <div className={styles.wrapper}>
      <div className={styles.controls}>
        <Input
          prefix={<Icon name="search" />}
          placeholder="Search span name..."
          width={24}
          value={spanSearch}
          onChange={(e) => setSpanSearch(e.currentTarget.value)}
        />
        <label className={styles.label}>Status:</label>
        <Select
          options={statusOptions}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v.value ?? '')}
          width={12}
        />
        <label className={styles.label}>Min (ms):</label>
        <input
          className={styles.durationInput}
          type="number"
          placeholder="0"
          value={durationMin}
          onChange={(e) => setDurationMin(e.target.value)}
        />
        <label className={styles.label}>Max (ms):</label>
        <input
          className={styles.durationInput}
          type="number"
          placeholder="∞"
          value={durationMax}
          onChange={(e) => setDurationMax(e.target.value)}
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
  durationInput: css`
    width: 70px;
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
