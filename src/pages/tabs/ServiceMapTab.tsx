import React, { useMemo } from 'react';
import { LoadingPlaceholder, Alert, useStyles2 } from '@grafana/ui';
import { FieldType, GrafanaTheme2, LoadingState, toDataFrame } from '@grafana/data';
import { css } from '@emotion/css';
import {
  SceneTimeRange,
  SceneDataNode,
  EmbeddedScene,
  SceneFlexLayout,
  SceneFlexItem,
  VizPanel,
} from '@grafana/scenes';
import { getServiceMap, ServiceMapResponse } from '../../api/client';
import { useFetch } from '../../utils/useFetch';

export interface ServiceMapTabProps {
  service: string;
  namespace: string;
  fromMs: number;
  toMs: number;
}

export function ServiceMapTab({ service, namespace, fromMs, toMs }: ServiceMapTabProps) {
  const styles = useStyles2(getStyles);
  const { data: mapData, loading, error } = useFetch<ServiceMapResponse>(
    () => getServiceMap(fromMs, toMs, service, namespace),
    [service, namespace, fromMs, toMs]
  );

  const scene = useMemo(() => {
    if (!mapData || mapData.nodes.length === 0) {
      return null;
    }

    const nodesFrame = toDataFrame({
      name: 'nodes',
      fields: [
        { name: 'id', type: FieldType.string, values: mapData.nodes.map((n) => n.id) },
        { name: 'title', type: FieldType.string, values: mapData.nodes.map((n) => n.title) },
        { name: 'mainStat', type: FieldType.string, values: mapData.nodes.map((n) => n.mainStat ?? '') },
        { name: 'secondaryStat', type: FieldType.string, values: mapData.nodes.map((n) => n.secondaryStat ?? '') },
        { name: 'arc__errors', type: FieldType.number, values: mapData.nodes.map((n) => n.arc__errors), config: { color: { fixedColor: 'red', mode: 'fixed' } } },
        { name: 'arc__ok', type: FieldType.number, values: mapData.nodes.map((n) => n.arc__ok), config: { color: { fixedColor: 'green', mode: 'fixed' } } },
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
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          new SceneFlexItem({
            minHeight: 600,
            body: new VizPanel({
              title: `Service Map — ${service}`,
              pluginId: 'nodeGraph',
              $data: dataNode,
              options: {},
              fieldConfig: { defaults: {}, overrides: [] },
            }),
          }),
        ],
      }),
    });
  }, [mapData, service]);

  if (loading) {
    return <LoadingPlaceholder text="Loading service map..." />;
  }

  if (error) {
    return <Alert severity="error" title="Error loading service map">{error}</Alert>;
  }

  if (!scene) {
    return (
      <Alert severity="info" title="No service map data">
        No service graph data found for {service}.
      </Alert>
    );
  }

  return <div className={styles.wrapper}><scene.Component model={scene} /></div>;
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
  `,
});
