import React, { useMemo } from 'react';
import { PluginPage } from '@grafana/runtime';
import { Alert, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2, PageLayoutType } from '@grafana/data';
import { css } from '@emotion/css';
import { getServiceMap, ServiceMapResponse } from '../api/client';
import { useTimeRange } from '../utils/timeRange';
import { useFetch } from '../utils/useFetch';
import { ServiceGraph, toGraphData } from '../components/ServiceGraph';

function ServiceMap() {
  const styles = useStyles2(getStyles);
  const { fromMs, toMs } = useTimeRange();
  const {
    data: mapData,
    loading,
    error,
  } = useFetch<ServiceMapResponse>(() => getServiceMap(fromMs, toMs), [fromMs, toMs]);

  const { graphNodes, graphEdges } = useMemo(() => toGraphData(mapData), [mapData]);

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
