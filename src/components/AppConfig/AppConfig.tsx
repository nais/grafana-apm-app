import React, { useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps, PluginMeta } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { Alert, Button, Field, FieldSet, Input, useStyles2 } from '@grafana/ui';
import { testIds } from '../testIds';
import { Capabilities, getCapabilities } from '../../api/client';

type AppPluginSettings = {
  metricsDataSource?: { uid: string; type: string };
  tracesDataSource?: { uid: string; type: string };
  logsDataSource?: { uid: string; type: string };
  metricNamespace?: string;
  durationUnit?: string;
};

type State = {
  metricsUid: string;
  tracesUid: string;
  logsUid: string;
  metricNamespace: string;
  durationUnit: string;
};

export interface AppConfigProps extends PluginConfigPageProps<AppPluginMeta<AppPluginSettings>> {}

const AppConfig = ({ plugin }: AppConfigProps) => {
  const s = useStyles2(getStyles);
  const { enabled, pinned, jsonData } = plugin.meta;
  const [state, setState] = useState<State>({
    metricsUid: jsonData?.metricsDataSource?.uid || '',
    tracesUid: jsonData?.tracesDataSource?.uid || '',
    logsUid: jsonData?.logsDataSource?.uid || '',
    metricNamespace: jsonData?.metricNamespace || '',
    durationUnit: jsonData?.durationUnit || '',
  });
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [detecting, setDetecting] = useState(false);

  const onAutoDetect = async () => {
    setDetecting(true);
    try {
      const result = await getCapabilities();
      setCaps(result);
      if (result.spanMetrics.detected) {
        setState((prev) => ({
          ...prev,
          metricNamespace: result.spanMetrics.namespace || prev.metricNamespace,
          durationUnit: result.spanMetrics.durationUnit || prev.durationUnit,
        }));
      }
    } catch (e) {
      console.error('Auto-detect failed', e);
    } finally {
      setDetecting(false);
    }
  };

  const onChange = (field: keyof State) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setState((prev) => ({ ...prev, [field]: e.target.value.trim() }));
  };

  const onSubmit = () => {
    updatePluginAndReload(plugin.meta.id, {
      enabled,
      pinned,
      jsonData: {
        metricsDataSource: { uid: state.metricsUid, type: 'prometheus' },
        tracesDataSource: { uid: state.tracesUid, type: 'tempo' },
        logsDataSource: { uid: state.logsUid, type: 'loki' },
        metricNamespace: state.metricNamespace || undefined,
        durationUnit: state.durationUnit || undefined,
      },
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <FieldSet label="Data Sources">
        <Field label="Metrics (Prometheus/Mimir) UID">
          <Input
            width={40}
            data-testid={testIds.appConfig.apiUrl}
            value={state.metricsUid}
            placeholder="e.g., mimir"
            onChange={onChange('metricsUid')}
          />
        </Field>
        <Field label="Traces (Tempo) UID">
          <Input
            width={40}
            value={state.tracesUid}
            placeholder="e.g., tempo"
            onChange={onChange('tracesUid')}
          />
        </Field>
        <Field label="Logs (Loki) UID">
          <Input
            width={40}
            value={state.logsUid}
            placeholder="e.g., loki"
            onChange={onChange('logsUid')}
          />
        </Field>
      </FieldSet>

      <FieldSet label="Detection & Overrides" className={s.marginTop}>
        <div className={s.detectRow}>
          <Button variant="secondary" onClick={onAutoDetect} disabled={detecting}>
            {detecting ? 'Detecting...' : 'Auto-detect capabilities'}
          </Button>
        </div>

        {caps?.spanMetrics.detected && (
          <Alert severity="success" title="Span metrics detected" className={s.marginTop}>
            Namespace: <strong>{caps.spanMetrics.namespace}</strong>, Duration unit:{' '}
            <strong>{caps.spanMetrics.durationUnit}</strong>, Services found:{' '}
            <strong>{caps.services?.length ?? 0}</strong>
          </Alert>
        )}

        <Field label="Metric Namespace (override)" description="Leave empty to auto-detect" className={s.marginTop}>
          <Input
            width={40}
            value={state.metricNamespace}
            placeholder="e.g., traces_span_metrics"
            onChange={onChange('metricNamespace')}
          />
        </Field>
        <Field label="Duration Unit (override)">
          <Input
            width={20}
            value={state.durationUnit}
            placeholder="ms or s"
            onChange={onChange('durationUnit')}
          />
        </Field>
      </FieldSet>

      <div className={s.marginTop}>
        <Button type="submit" data-testid={testIds.appConfig.submit}>
          Save settings
        </Button>
      </div>
    </form>
  );
};

export default AppConfig;

const getStyles = (theme: GrafanaTheme2) => ({
  marginTop: css`
    margin-top: ${theme.spacing(3)};
  `,
  detectRow: css`
    margin-bottom: ${theme.spacing(2)};
  `,
});

const updatePluginAndReload = async (pluginId: string, data: Partial<PluginMeta<AppPluginSettings>>) => {
  try {
    await updatePlugin(pluginId, data);
    window.location.reload();
  } catch (e) {
    console.error('Error while updating the plugin', e);
  }
};

const updatePlugin = async (pluginId: string, data: Partial<PluginMeta>) => {
  const response = await getBackendSrv().fetch({
    url: `/api/plugins/${pluginId}/settings`,
    method: 'POST',
    data,
  });
  return lastValueFrom(response);
};
