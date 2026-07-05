import React, { useMemo, useState } from 'react';
import { useStyles2, Combobox } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import {
  SceneTimeRange,
  SceneQueryRunner,
  EmbeddedScene,
  SceneFlexLayout,
  SceneFlexItem,
  PanelBuilders,
} from '@grafana/scenes';
import { sanitizeLabelValue } from '../../utils/sanitize';
import { useTimeRange } from '../../utils/timeRange';
import { useSceneTimeSync } from '../../utils/useSceneTimeSync';

interface ProfilingTabProps {
  service: string;
  namespace: string;
  /** UID of the detected Pyroscope datasource (caps.pyroscope.uid). The tab is
   * only mounted when this is set, so it is always a real UID here. */
  pyroscopeUid: string;
  /** Pyroscope conventionally labels services under `service_name`; overridable
   * for parity with the app's label config. */
  serviceNameLabel?: string;
}

// Profile types offered by the selector. `value` is Pyroscope's fully-qualified
// profileTypeId in `name:sampleType:sampleUnit:periodType:periodUnit` form —
// the exact shape the grafana-pyroscope-datasource query model expects
// (@grafana/schema GrafanaPyroscopeDataQuery.profileTypeId). CPU plus the two
// memory profiles cover the standard flame-graph views; goroutines is a common
// Go extra.
const PROFILE_TYPES: Array<{ label: string; value: string }> = [
  { label: 'CPU', value: 'process_cpu:cpu:nanoseconds:cpu:nanoseconds' },
  { label: 'Memory — in-use space', value: 'memory:inuse_space:bytes:space:bytes' },
  { label: 'Memory — allocated space', value: 'memory:alloc_space:bytes:space:bytes' },
  { label: 'Memory — allocated objects', value: 'memory:alloc_objects:count:space:bytes' },
  { label: 'Goroutines', value: 'goroutine:goroutines:count:goroutine:count' },
];

const PYROSCOPE_DS_TYPE = 'grafana-pyroscope-datasource';

/**
 * ProfilingTab renders continuous-profiling views for a service from a
 * Pyroscope datasource: a samples-over-time series and a flame graph for the
 * selected profile type (CPU or memory). It is only reachable when the backend
 * /capabilities probe reports `pyroscope.available` — production has no
 * Pyroscope today, so in practice the tab is hidden entirely.
 *
 * Follow-up (both Tempo + Pyroscope present): span→profile links — Tempo trace
 * spans carry a pyroscope profile id that deep-links into a span-scoped flame
 * graph (the datasource's `spanSelector` query field). Not built here because
 * production runs neither datasource in tandem yet.
 */
export function ProfilingTab({ service, pyroscopeUid, serviceNameLabel = 'service_name' }: ProfilingTabProps) {
  const styles = useStyles2(getStyles);
  const [profileType, setProfileType] = useState<string>(PROFILE_TYPES[0].value);
  // Resolved timestamps drive the scene window AND bust the memo on a global
  // time-picker refresh (from/to strings stay relative but fromMs/toMs
  // re-resolve), so the scene rebuilds and re-queries the fresh window.
  const { fromMs, toMs } = useTimeRange();

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    });

    const labelSelector = `{${serviceNameLabel}="${sanitizeLabelValue(service)}"}`;
    const datasource = { uid: pyroscopeUid, type: PYROSCOPE_DS_TYPE };

    // Two query runners against the same datasource: `metrics` yields the
    // time-series of samples, `profile` yields the flame graph. profileTypeId +
    // labelSelector are the datasource's required query fields.
    const metricsQuery = new SceneQueryRunner({
      datasource,
      queries: [
        {
          refId: 'A',
          queryType: 'metrics',
          profileTypeId: profileType,
          labelSelector,
          groupBy: [],
        },
      ],
    });

    const profileQuery = new SceneQueryRunner({
      datasource,
      queries: [
        {
          refId: 'A',
          queryType: 'profile',
          profileTypeId: profileType,
          labelSelector,
          groupBy: [],
          maxNodes: 16384,
        },
      ],
    });

    return new EmbeddedScene({
      $timeRange: timeRange,
      controls: [],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          new SceneFlexItem({
            minHeight: 160,
            maxHeight: 220,
            body: PanelBuilders.timeseries().setTitle('Profile samples over time').setData(metricsQuery).build(),
          }),
          new SceneFlexItem({
            minHeight: 500,
            body: PanelBuilders.flamegraph().setTitle(`Flame graph — ${service}`).setData(profileQuery).build(),
          }),
        ],
      }),
    });
  }, [service, pyroscopeUid, serviceNameLabel, profileType, fromMs, toMs]);

  // Follow the global header time range: rebuilds on from/to string changes,
  // this re-resolves relative ranges in place on a refresh tick.
  useSceneTimeSync(scene, fromMs, toMs);

  return (
    <div className={styles.wrapper}>
      <div className={styles.controls}>
        <label className={styles.label}>Profile type:</label>
        <Combobox
          options={PROFILE_TYPES}
          value={profileType}
          onChange={(v) => setProfileType(v?.value ?? PROFILE_TYPES[0].value)}
          width={32}
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
  label: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  sceneWrapper: css`
    flex: 1;
    min-height: 0;
    overflow: auto;
  `,
});
