import React, { useMemo } from 'react';
import { PluginPage } from '@grafana/runtime';
import { Alert, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2, FieldType, LoadingState, toDataFrame, PageLayoutType } from '@grafana/data';
import { css } from '@emotion/css';
import {
  SceneFlexLayout,
  SceneFlexItem,
  SceneDataNode,
  EmbeddedScene,
  SceneTimePicker,
  SceneTimeRange,
  SceneRefreshPicker,
  VizPanel,
} from '@grafana/scenes';
import { getServiceMap, ServiceMapResponse } from '../api/client';
import { useTimeRange } from '../utils/timeRange';
import { useFetch } from '../utils/useFetch';

function ServiceMap() {
  const styles = useStyles2(getStyles);
  const { fromMs, toMs } = useTimeRange();
  const {
    data: mapData,
    loading,
    error,
  } = useFetch<ServiceMapResponse>(() => getServiceMap(fromMs, toMs), [fromMs, toMs]);

  const scene = useMemo(() => {
    if (!mapData || mapData.nodes.length === 0) {
      return null;
    }

    // Build Node Graph DataFrames
    const nodesFrame = toDataFrame({
      name: 'nodes',
      fields: [
        { name: 'id', type: FieldType.string, values: mapData.nodes.map((n) => n.id) },
        { name: 'title', type: FieldType.string, values: mapData.nodes.map((n) => n.title) },
        { name: 'mainStat', type: FieldType.string, values: mapData.nodes.map((n) => n.mainStat ?? '') },
        { name: 'secondaryStat', type: FieldType.string, values: mapData.nodes.map((n) => n.secondaryStat ?? '') },
        {
          name: 'arc__errors',
          type: FieldType.number,
          values: mapData.nodes.map((n) => n.arc__errors),
          config: { color: { fixedColor: 'red', mode: 'fixed' } },
        },
        {
          name: 'arc__ok',
          type: FieldType.number,
          values: mapData.nodes.map((n) => n.arc__ok),
          config: { color: { fixedColor: 'green', mode: 'fixed' } },
        },
      ],
    });

    const edgesFrame = toDataFrame({
      name: 'edges',
      fields: [
        { name: 'id', type: FieldType.string, values: mapData.edges.map((e) => e.id) },
        { name: 'source', type: FieldType.string, values: mapData.edges.map((e) => e.source) },
        { name: 'target', type: FieldType.string, values: mapData.edges.map((e) => e.target) },
        { name: 'mainStat', type: FieldType.string, values: mapData.edges.map((e) => e.mainStat ?? '') },
        { name: 'secondaryStat', type: FieldType.string, values: mapData.edges.map((e) => e.secondaryStat ?? '') },
      ],
    });

    nodesFrame.meta = { preferredVisualisationType: 'nodeGraph' };

    const dataNode = new SceneDataNode({
      data: {
        series: [nodesFrame, edgesFrame],
        state: LoadingState.Done,
        timeRange: { from: new Date(), to: new Date(), raw: { from: 'now-1h', to: 'now' } } as any,
      },
    });

    return new EmbeddedScene({
      $timeRange: new SceneTimeRange({ from: 'now-1h', to: 'now' }),
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          new SceneFlexItem({
            minHeight: 500,
            body: new VizPanel({
              title: 'Service Map',
              pluginId: 'nodeGraph',
              $data: dataNode,
              options: {},
              fieldConfig: { defaults: {}, overrides: [] },
            }),
          }),
        ],
      }),
    });
  }, [mapData]);

  return (
    <PluginPage layout={PageLayoutType.Canvas}>
      <div className={styles.container}>
        {error && (
          <Alert severity="error" title="Error">
            {error}
          </Alert>
        )}
        {loading && <LoadingPlaceholder text="Loading service map..." />}

        {!loading && mapData && mapData.nodes.length === 0 && (
          <Alert severity="warning" title="No service graph data">
            Service graph metrics not found. Ensure the OTel Collector servicegraph connector is configured.
          </Alert>
        )}

        {!loading && scene && <scene.Component model={scene} />}

        {!loading && mapData && mapData.nodes.length > 0 && (
          <div className={styles.legend}>
            <p>Click a node to navigate to the service detail page.</p>
          </div>
        )}
      </div>
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    padding: 0;
  `,
  legend: css`
    margin-top: ${theme.spacing(2)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});

export default ServiceMap;
