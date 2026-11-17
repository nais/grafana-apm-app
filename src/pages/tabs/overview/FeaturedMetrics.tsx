import React, { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Combobox, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import {
  EmbeddedScene,
  PanelBuilders,
  SceneFlexItem,
  SceneFlexLayout,
  SceneQueryRunner,
  SceneTimeRange,
} from '@grafana/scenes';
import { CustomMetricsResponse } from '../../../api/client';
import {
  customMetricPanels,
  runtimeMetricFilter,
  CustomMetricPanelSpec,
} from '../../../components/customMetricQueries';
import { CollapsibleSection } from '../../../components/CollapsibleSection';
import { usePluginDatasources } from '../../../utils/datasources';
import { useTimeRange } from '../../../utils/timeRange';
import { useSceneTimeSync } from '../../../utils/useSceneTimeSync';
import { useUrlParams } from '../../../utils/useUrlState';
import { usePinnedMetrics } from '../../../utils/userStorage';

const SLOTS = ['overviewMetric1', 'overviewMetric2', 'overviewMetric3'];

interface FeaturedMetricsProps {
  namespace: string;
  service: string;
  environment?: string;
  data: CustomMetricsResponse | null;
  loading: boolean;
  error: string | null;
}

export function FeaturedMetrics({ namespace, service, environment, data, loading, error }: FeaturedMetricsProps) {
  const styles = useStyles2(getStyles);
  const [params] = useSearchParams();
  const updateParams = useUrlParams();
  const pinned = usePinnedMetrics(namespace, service);
  const { metricsUid } = usePluginDatasources(environment);
  const { from, to, fromMs, toMs } = useTimeRange();
  const metrics = useMemo(() => data?.metrics.filter((metric) => !metric.highCardinality) ?? [], [data]);
  const choices = metrics.map((metric) => ({ label: metric.name, value: metric.name }));
  const urlSelections = SLOTS.some((key) => params.has(key));
  const first = urlSelections ? (params.get(SLOTS[0]) ?? '') : (pinned.metrics[0] ?? '');
  const second = urlSelections ? (params.get(SLOTS[1]) ?? '') : (pinned.metrics[1] ?? '');
  const third = urlSelections ? (params.get(SLOTS[2]) ?? '') : (pinned.metrics[2] ?? '');
  const selected = useMemo(() => [first, second, third], [first, second, third]);
  const filter = runtimeMetricFilter(service, namespace);
  const panelSpecs = JSON.stringify(
    selected
      .map((name, index) =>
        selected.indexOf(name) === index ? metrics.find((metric) => metric.name === name) : undefined
      )
      .filter((metric) => metric !== undefined)
      .map((metric) => ({ spec: customMetricPanels(metric, filter)[0], help: metric.help }))
  );
  const scene = useMemo(() => {
    const specs = JSON.parse(panelSpecs) as Array<{ spec: CustomMetricPanelSpec; help: string }>;
    const items = specs.map(({ spec, help }) => {
      const runner = new SceneQueryRunner({
        datasource: { uid: metricsUid, type: 'prometheus' },
        queries: spec.queries,
      });
      let panel = PanelBuilders.timeseries().setTitle(spec.title).setData(runner);
      if (help) {
        panel = panel.setDescription(help);
      }
      if (spec.unit) {
        panel = panel.setUnit(spec.unit);
      }
      return new SceneFlexItem({ minWidth: '320px', height: 220, body: panel.build() });
    });

    return items.length && metricsUid
      ? new EmbeddedScene({
          $timeRange: new SceneTimeRange({ from, to }),
          body: new SceneFlexLayout({ direction: 'row', wrap: 'wrap', children: items }),
        })
      : null;
  }, [panelSpecs, metricsUid, from, to]);

  useSceneTimeSync(scene, fromMs, toMs);

  return (
    <section className={styles.section} aria-label="Selected metrics">
      {error && <p role="alert">Could not load application metrics: {error}</p>}
      {pinned.error && <p role="alert">{pinned.error}</p>}
      {scene && <scene.Component key={panelSpecs + metricsUid + from + to} model={scene} />}
      <CollapsibleSection
        label={selected.some(Boolean) ? 'Selected metrics · Configure' : 'Select metrics'}
        className={styles.config}
      >
        <p className={styles.subtitle}>Choose up to three application metrics to display below the service graphs.</p>
        {loading && !data && <p>Loading application metrics...</p>}
        {!pinned.loaded && <p>Loading saved metrics...</p>}
        {!loading && !error && metrics.length === 0 && <p>No chartable application metrics found for this service.</p>}
        {metrics.length > 0 && (
          <div className={styles.selectors}>
            {SLOTS.map((key, index) => {
              const value = selected[index];
              return (
                <div key={key}>
                  <label id={`${key}-label`}>Metric {index + 1}</label>
                  <Combobox
                    aria-labelledby={`${key}-label`}
                    disabled={!pinned.loaded}
                    options={[
                      { label: 'None', value: '' },
                      ...choices.filter((choice) => choice.value === value || !selected.includes(choice.value)),
                    ]}
                    value={metrics.some((metric) => metric.name === value) ? value : ''}
                    onChange={(option) => {
                      const next = selected.map((name, slot) => (slot === index ? (option.value ?? '') : name));
                      updateParams(Object.fromEntries(SLOTS.map((slot, position) => [slot, next[position]])));
                      pinned.save(next);
                    }}
                    width={28}
                  />
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleSection>
    </section>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  section: css`
    margin-bottom: ${theme.spacing(2)};
  `,
  config: css`
    margin-top: ${theme.spacing(1)};
  `,
  subtitle: css`
    color: ${theme.colors.text.secondary};
    margin-bottom: ${theme.spacing(1.5)};
  `,
  selectors: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(2)};
    label {
      display: block;
      margin-bottom: ${theme.spacing(0.5)};
    }
  `,
});
