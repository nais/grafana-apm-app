import React, { useMemo } from 'react';
import { PluginPage } from '@grafana/runtime';
import { Alert, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2, PageLayoutType } from '@grafana/data';
import { css } from '@emotion/css';
import { getServiceMap, ServiceMapResponse } from '../api/client';
import { useTimeRange } from '../utils/timeRange';
import { useFetch } from '../utils/useFetch';
import { ServiceGraph, type ServiceGraphNode, type ServiceGraphEdge } from '../components/ServiceGraph';

function ServiceMap() {
  const styles = useStyles2(getStyles);
  const { fromMs, toMs } = useTimeRange();
  const {
    data: mapData,
    loading,
    error,
  } = useFetch<ServiceMapResponse>(() => getServiceMap(fromMs, toMs), [fromMs, toMs]);

  const { graphNodes, graphEdges } = useMemo(() => {
    if (!mapData) {
      return { graphNodes: [], graphEdges: [] };
    }
    const graphNodes: ServiceGraphNode[] = mapData.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      mainStat: n.mainStat,
      secondaryStat: n.secondaryStat,
      errorRate: n.errorRate ?? 0,
      nodeType: n.nodeType,
    }));
    const graphEdges: ServiceGraphEdge[] = mapData.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      mainStat: e.mainStat,
      secondaryStat: e.secondaryStat,
    }));
    return { graphNodes, graphEdges };
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

        {!loading && graphNodes.length === 0 && (
          <Alert severity="warning" title="No service graph data">
            Service graph metrics not found. Ensure the OTel Collector servicegraph connector is configured.
          </Alert>
        )}

        {!loading && graphNodes.length > 0 && (
          <ServiceGraph nodes={graphNodes} edges={graphEdges} direction="RIGHT" enableGrouping={false} />
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
    height: 100%;
  `,
});

export default ServiceMap;
