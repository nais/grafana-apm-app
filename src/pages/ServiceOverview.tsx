import React, { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { useStyles2, LinkButton } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import {
  SceneFlexLayout,
  SceneFlexItem,
  SceneQueryRunner,
  SceneTimePicker,
  SceneTimeRange,
  PanelBuilders,
  EmbeddedScene,
} from '@grafana/scenes';
import { buildTempoExploreUrl, buildLokiExploreUrl } from '../utils/explore';

function ServiceOverview() {
  const { namespace = '', service = '' } = useParams<{ namespace: string; service: string }>();
  const styles = useStyles2(getStyles);

  // Build Scenes panels for RED metrics
  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({ from: 'now-1h', to: 'now' });

    const rateQuery = new SceneQueryRunner({
      datasource: { uid: 'mimir', type: 'prometheus' },
      queries: [
        {
          refId: 'A',
          expr: `sum(rate(traces_span_metrics_calls_total{service_name="${service}", service_namespace="${namespace}", span_kind="SPAN_KIND_SERVER"}[5m]))`,
        },
      ],
    });

    const errorQuery = new SceneQueryRunner({
      datasource: { uid: 'mimir', type: 'prometheus' },
      queries: [
        {
          refId: 'A',
          expr: `sum(rate(traces_span_metrics_calls_total{service_name="${service}", service_namespace="${namespace}", span_kind="SPAN_KIND_SERVER", status_code="STATUS_CODE_ERROR"}[5m])) / sum(rate(traces_span_metrics_calls_total{service_name="${service}", service_namespace="${namespace}", span_kind="SPAN_KIND_SERVER"}[5m])) * 100`,
          legendFormat: 'Error %',
        },
      ],
    });

    const durationQuery = new SceneQueryRunner({
      datasource: { uid: 'mimir', type: 'prometheus' },
      queries: [
        {
          refId: 'A',
          expr: `histogram_quantile(0.95, sum by (le) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name="${service}", service_namespace="${namespace}", span_kind="SPAN_KIND_SERVER"}[5m])))`,
          legendFormat: 'P95',
        },
      ],
    });

    return new EmbeddedScene({
      $timeRange: timeRange,
      controls: [new SceneTimePicker({})],
      body: new SceneFlexLayout({
        direction: 'row',
        children: [
          new SceneFlexItem({
            body: PanelBuilders.timeseries()
              .setTitle('Duration (P95)')
              .setData(durationQuery)
              .setUnit('ms')
              .build(),
          }),
          new SceneFlexItem({
            body: PanelBuilders.timeseries()
              .setTitle('Errors')
              .setData(errorQuery)
              .setUnit('percent')
              .build(),
          }),
          new SceneFlexItem({
            body: PanelBuilders.timeseries()
              .setTitle('Rate')
              .setData(rateQuery)
              .setUnit('reqps')
              .build(),
          }),
        ],
      }),
    });
  }, [service, namespace]);

  const tempoUrl = buildTempoExploreUrl('tempo', service);
  const lokiUrl = buildLokiExploreUrl('loki', service);

  return (
    <PluginPage>
      <div className={styles.container}>
        <div className={styles.header}>
          <h2>
            {namespace}/{service}
          </h2>
          <div className={styles.links}>
            <LinkButton variant="secondary" size="sm" icon="compass" href={tempoUrl}>
              Traces
            </LinkButton>
            <LinkButton variant="secondary" size="sm" icon="document-info" href={lokiUrl}>
              Logs
            </LinkButton>
          </div>
        </div>

        <scene.Component model={scene} />
      </div>
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    padding: ${theme.spacing(2)};
  `,
  header: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: ${theme.spacing(2)};
  `,
  links: css`
    display: flex;
    gap: ${theme.spacing(1)};
  `,
});

export default ServiceOverview;
