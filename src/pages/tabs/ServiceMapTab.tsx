import React, { useMemo } from 'react';
import { LoadingPlaceholder, Alert } from '@grafana/ui';
import { getServiceMap, ServiceMapResponse } from '../../api/client';
import { useFetch } from '../../utils/useFetch';
import { ServiceGraph, type ServiceGraphNode, type ServiceGraphEdge } from '../../components/ServiceGraph';

export interface ServiceMapTabProps {
  service: string;
  namespace: string;
  fromMs: number;
  toMs: number;
}

export function ServiceMapTab({ service, namespace, fromMs, toMs }: ServiceMapTabProps) {
  const {
    data: mapData,
    loading,
    error,
  } = useFetch<ServiceMapResponse>(
    () => getServiceMap(fromMs, toMs, service, namespace),
    [service, namespace, fromMs, toMs]
  );

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

  if (loading) {
    return <LoadingPlaceholder text="Loading service map..." />;
  }

  if (error) {
    return (
      <Alert severity="error" title="Error loading service map">
        {error}
      </Alert>
    );
  }

  if (graphNodes.length === 0) {
    return (
      <Alert severity="info" title="No service map data">
        No service graph data found for {service}.
      </Alert>
    );
  }

  return <ServiceGraph nodes={graphNodes} edges={graphEdges} focusNode={service} direction="RIGHT" />;
}
