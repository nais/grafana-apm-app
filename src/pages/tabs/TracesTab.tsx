import React, { useMemo, useState } from 'react';
import { useStyles2, Combobox, Input, Icon } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
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
import { escapeQueryString } from '../../utils/sanitize';

/** Map OTel span kind values to TraceQL kind literals. */
function mapSpanKindToTraceQL(raw: string): string {
  switch (raw) {
    case 'SPAN_KIND_SERVER':
      return 'server';
    case 'SPAN_KIND_CLIENT':
      return 'client';
    case 'SPAN_KIND_PRODUCER':
      return 'producer';
    case 'SPAN_KIND_CONSUMER':
      return 'consumer';
    case 'SPAN_KIND_INTERNAL':
      return 'internal';
    default:
      return raw.toLowerCase();
  }
}

interface TracesTabProps {
  service: string;
  namespace: string;
  tracesUid: string;
  from: string;
  to: string;
  initialSpan?: string;
  initialStatus?: string;
  initialSpanKind?: string;
}

export function TracesTab({
  service,
  namespace,
  tracesUid,
  from,
  to,
  initialSpan,
  initialStatus,
  initialSpanKind,
}: TracesTabProps) {
  const [statusFilter, setStatusFilter] = useState<string>(initialStatus ?? '');
  const [durationMin, setDurationMin] = useState<string>('');
  const [durationMax, setDurationMax] = useState<string>('');
  const [spanSearch, setSpanSearch] = useState<string>(initialSpan ?? '');
  const debouncedSearch = useDebouncedValue(spanSearch, 500);
  const styles = useStyles2(getStyles);

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from, to });

    // Note: resource.service.namespace may differ between signals (e.g., span metrics
    // report "opentelemetry-demo" while traces/logs report "demo"). Only filter by
    // service.name for reliability; namespace scoping is handled at the backend API level.
    const conditions: string[] = [`resource.service.name="${escapeQueryString(service)}"`];
    if (initialSpanKind) {
      conditions.push(`kind=${mapSpanKindToTraceQL(initialSpanKind)}`);
    }
    if (statusFilter === 'error') {
      conditions.push(`status=error`);
    } else if (statusFilter === 'ok') {
      conditions.push(`status=ok`);
    }
    if (debouncedSearch) {
      const escaped = escapeQueryString(escapeRegex(debouncedSearch));
      // Search both span name and http.route — metric span names often come from
      // http.route which may differ from the trace span name (e.g. Ktor includes
      // auth wrappers like "(authenticate tokenX)" in http.route but not in name).
      conditions.push(`(name=~".*${escaped}.*" || span.http.route=~".*${escaped}.*")`);
    }
    if (durationMin) {
      conditions.push(`duration >= ${durationMin}ms`);
    }
    if (durationMax) {
      conditions.push(`duration <= ${durationMax}ms`);
    }
    const traceQL = `{${conditions.join(' && ')}}`;

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
  }, [service, tracesUid, from, to, statusFilter, durationMin, durationMax, debouncedSearch, initialSpanKind]);

  const statusOptions: Array<{ label: string; value: string }> = [
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
        <Combobox
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
