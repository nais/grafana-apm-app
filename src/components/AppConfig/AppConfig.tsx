import React, { useEffect, useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps, PluginMeta, SelectableValue } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { Alert, Button, Field, FieldSet, IconButton, Input, Select, useStyles2 } from '@grafana/ui';
import { testIds } from '../testIds';
import { Capabilities, getCapabilities } from '../../api/client';

interface GrafanaDataSource {
  uid: string;
  name: string;
  type: string;
  isDefault: boolean;
}

interface DsRef {
  uid?: string;
  type?: string;
}

interface EnvAwareDs {
  uid?: string;
  type?: string;
  byEnvironment?: Record<string, DsRef>;
}

type AppPluginSettings = {
  metricsDataSource?: DsRef;
  tracesDataSource?: EnvAwareDs;
  logsDataSource?: EnvAwareDs;
  metricNamespace?: string;
  durationUnit?: string;
};

interface EnvOverride {
  env: string;
  tempoUid: string;
  lokiUid: string;
}

type State = {
  metricsUid: string;
  tracesUid: string;
  logsUid: string;
  metricNamespace: string;
  durationUnit: string;
  envOverrides: EnvOverride[];
};

function parseEnvOverrides(tracesDs: EnvAwareDs | undefined, logsDs: EnvAwareDs | undefined): EnvOverride[] {
  const envs = new Set<string>([
    ...Object.keys(tracesDs?.byEnvironment ?? {}),
    ...Object.keys(logsDs?.byEnvironment ?? {}),
  ]);
  return [...envs].sort().map((env) => ({
    env,
    tempoUid: tracesDs?.byEnvironment?.[env]?.uid || '',
    lokiUid: logsDs?.byEnvironment?.[env]?.uid || '',
  }));
}

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
    envOverrides: parseEnvOverrides(jsonData?.tracesDataSource, jsonData?.logsDataSource),
  });
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [detecting, setDetecting] = useState(false);

  // Datasource options fetched from Grafana API
  const [promOptions, setPromOptions] = useState<Array<SelectableValue<string>>>([]);
  const [tempoOptions, setTempoOptions] = useState<Array<SelectableValue<string>>>([]);
  const [lokiOptions, setLokiOptions] = useState<Array<SelectableValue<string>>>([]);
  const [dsLoaded, setDsLoaded] = useState(false);

  useEffect(() => {
    getBackendSrv()
      .get('/api/datasources')
      .then((datasources: GrafanaDataSource[]) => {
        const toOption = (ds: GrafanaDataSource): SelectableValue<string> => ({
          label: `${ds.name}${ds.isDefault ? ' (default)' : ''}`,
          value: ds.uid,
          description: ds.uid,
        });

        const prom = datasources.filter((ds) => ds.type === 'prometheus').map(toOption);
        const tempo = datasources.filter((ds) => ds.type === 'tempo').map(toOption);
        const loki = datasources.filter((ds) => ds.type === 'loki').map(toOption);

        setPromOptions(prom);
        setTempoOptions(tempo);
        setLokiOptions(loki);
        setDsLoaded(true);

        // Auto-fill empty fields: prefer isDefault, then sole datasource
        setState((prev) => {
          const updates: Partial<State> = {};
          if (!prev.metricsUid) {
            const def = datasources.find((d) => d.type === 'prometheus' && d.isDefault);
            updates.metricsUid = def?.uid || (prom.length === 1 ? prom[0].value! : '');
          }
          if (!prev.tracesUid) {
            const def = datasources.find((d) => d.type === 'tempo' && d.isDefault);
            updates.tracesUid = def?.uid || (tempo.length === 1 ? tempo[0].value! : '');
          }
          if (!prev.logsUid) {
            const def = datasources.find((d) => d.type === 'loki' && d.isDefault);
            updates.logsUid = def?.uid || (loki.length === 1 ? loki[0].value! : '');
          }

          // Auto-detect environment overrides from naming patterns
          if (prev.envOverrides.length === 0 && (tempo.length > 1 || loki.length > 1)) {
            const envMap = new Map<string, { tempoUid: string; lokiUid: string }>();
            const envPattern = /^(.+?)[-_](tempo|loki)$/i;
            for (const ds of datasources) {
              if (ds.type !== 'tempo' && ds.type !== 'loki') {
                continue;
              }
              const match = ds.name.match(envPattern) || ds.uid.match(envPattern);
              if (match) {
                const env = match[1];
                const entry = envMap.get(env) || { tempoUid: '', lokiUid: '' };
                if (ds.type === 'tempo') {
                  entry.tempoUid = ds.uid;
                } else {
                  entry.lokiUid = ds.uid;
                }
                envMap.set(env, entry);
              }
            }
            if (envMap.size > 0) {
              updates.envOverrides = [...envMap.entries()].sort().map(([env, ds]) => ({
                env,
                tempoUid: ds.tempoUid,
                lokiUid: ds.lokiUid,
              }));
            }
          }

          return Object.keys(updates).length > 0 ? { ...prev, ...updates } : prev;
        });
      })
      .catch(() => {
        setDsLoaded(true);
      });
  }, []);

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

  const onChange = (field: keyof Omit<State, 'envOverrides'>) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setState((prev) => ({ ...prev, [field]: e.target.value.trim() }));
  };

  const onEnvChange = (idx: number, field: keyof EnvOverride) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setState((prev) => {
      const overrides = [...prev.envOverrides];
      overrides[idx] = { ...overrides[idx], [field]: e.target.value.trim() };
      return { ...prev, envOverrides: overrides };
    });
  };

  const addEnvOverride = () => {
    setState((prev) => ({
      ...prev,
      envOverrides: [...prev.envOverrides, { env: '', tempoUid: '', lokiUid: '' }],
    }));
  };

  const removeEnvOverride = (idx: number) => {
    setState((prev) => ({
      ...prev,
      envOverrides: prev.envOverrides.filter((_, i) => i !== idx),
    }));
  };

  const onSubmit = () => {
    // Build byEnvironment maps from overrides
    const tracesByEnv: Record<string, DsRef> = {};
    const logsByEnv: Record<string, DsRef> = {};
    for (const ov of state.envOverrides) {
      if (ov.env) {
        if (ov.tempoUid) {
          tracesByEnv[ov.env] = { uid: ov.tempoUid, type: 'tempo' };
        }
        if (ov.lokiUid) {
          logsByEnv[ov.env] = { uid: ov.lokiUid, type: 'loki' };
        }
      }
    }

    updatePluginAndReload(plugin.meta.id, {
      enabled,
      pinned,
      jsonData: {
        metricsDataSource: { uid: state.metricsUid, type: 'prometheus' },
        tracesDataSource: {
          uid: state.tracesUid,
          type: 'tempo',
          ...(Object.keys(tracesByEnv).length > 0 ? { byEnvironment: tracesByEnv } : {}),
        },
        logsDataSource: {
          uid: state.logsUid,
          type: 'loki',
          ...(Object.keys(logsByEnv).length > 0 ? { byEnvironment: logsByEnv } : {}),
        },
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
        <Field label="Metrics (Prometheus/Mimir)">
          {dsLoaded && promOptions.length > 0 ? (
            <Select
              options={promOptions}
              value={state.metricsUid || null}
              onChange={(v) => setState((prev) => ({ ...prev, metricsUid: v?.value ?? '' }))}
              width={40}
              placeholder="Select Prometheus datasource..."
              isClearable
              data-testid={testIds.appConfig.apiUrl}
            />
          ) : (
            <Input
              width={40}
              data-testid={testIds.appConfig.apiUrl}
              value={state.metricsUid}
              placeholder="e.g., mimir"
              onChange={onChange('metricsUid')}
            />
          )}
        </Field>
        <Field label="Traces (Tempo)" description="Default Tempo datasource">
          {dsLoaded && tempoOptions.length > 0 ? (
            <Select
              options={tempoOptions}
              value={state.tracesUid || null}
              onChange={(v) => setState((prev) => ({ ...prev, tracesUid: v?.value ?? '' }))}
              width={40}
              placeholder="Select Tempo datasource..."
              isClearable
            />
          ) : (
            <Input width={40} value={state.tracesUid} placeholder="e.g., tempo" onChange={onChange('tracesUid')} />
          )}
        </Field>
        <Field label="Logs (Loki)" description="Default Loki datasource">
          {dsLoaded && lokiOptions.length > 0 ? (
            <Select
              options={lokiOptions}
              value={state.logsUid || null}
              onChange={(v) => setState((prev) => ({ ...prev, logsUid: v?.value ?? '' }))}
              width={40}
              placeholder="Select Loki datasource..."
              isClearable
            />
          ) : (
            <Input width={40} value={state.logsUid} placeholder="e.g., loki" onChange={onChange('logsUid')} />
          )}
        </Field>
      </FieldSet>

      <FieldSet label="Per-Environment Datasources" className={s.marginTop}>
        <p className={s.description}>
          Override Tempo and Loki datasources for specific environments. When a user selects an environment filter,
          traces and logs will route to the matching datasource.
        </p>
        {state.envOverrides.map((ov, idx) => (
          <div key={idx} className={s.envRow}>
            <Field label="Environment">
              <Input width={20} value={ov.env} placeholder="e.g., dev-gcp" onChange={onEnvChange(idx, 'env')} />
            </Field>
            <Field label="Tempo">
              {dsLoaded && tempoOptions.length > 0 ? (
                <Select
                  options={tempoOptions}
                  value={ov.tempoUid || null}
                  onChange={(v) =>
                    setState((prev) => {
                      const overrides = [...prev.envOverrides];
                      overrides[idx] = { ...overrides[idx], tempoUid: v?.value ?? '' };
                      return { ...prev, envOverrides: overrides };
                    })
                  }
                  width={25}
                  placeholder="Select Tempo..."
                  isClearable
                />
              ) : (
                <Input
                  width={25}
                  value={ov.tempoUid}
                  placeholder="e.g., dev-gcp-tempo"
                  onChange={onEnvChange(idx, 'tempoUid')}
                />
              )}
            </Field>
            <Field label="Loki">
              {dsLoaded && lokiOptions.length > 0 ? (
                <Select
                  options={lokiOptions}
                  value={ov.lokiUid || null}
                  onChange={(v) =>
                    setState((prev) => {
                      const overrides = [...prev.envOverrides];
                      overrides[idx] = { ...overrides[idx], lokiUid: v?.value ?? '' };
                      return { ...prev, envOverrides: overrides };
                    })
                  }
                  width={25}
                  placeholder="Select Loki..."
                  isClearable
                />
              ) : (
                <Input
                  width={25}
                  value={ov.lokiUid}
                  placeholder="e.g., dev-gcp-loki"
                  onChange={onEnvChange(idx, 'lokiUid')}
                />
              )}
            </Field>
            <IconButton name="trash-alt" tooltip="Remove" onClick={() => removeEnvOverride(idx)} />
          </div>
        ))}
        <Button variant="secondary" icon="plus" onClick={addEnvOverride} size="sm">
          Add environment override
        </Button>
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
            {caps.tempoByEnv && Object.keys(caps.tempoByEnv).length > 0 && (
              <div style={{ marginTop: 8 }}>
                Per-environment Tempo:{' '}
                {Object.entries(caps.tempoByEnv).map(([env, st]) => (
                  <span key={env}>
                    <strong>{env}</strong>: {st.available ? '✓' : `✗ ${st.error}`}{' '}
                  </span>
                ))}
              </div>
            )}
            {caps.lokiByEnv && Object.keys(caps.lokiByEnv).length > 0 && (
              <div style={{ marginTop: 4 }}>
                Per-environment Loki:{' '}
                {Object.entries(caps.lokiByEnv).map(([env, st]) => (
                  <span key={env}>
                    <strong>{env}</strong>: {st.available ? '✓' : `✗ ${st.error}`}{' '}
                  </span>
                ))}
              </div>
            )}
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
          <Input width={20} value={state.durationUnit} placeholder="ms or s" onChange={onChange('durationUnit')} />
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
  description: css`
    color: ${theme.colors.text.secondary};
    margin-bottom: ${theme.spacing(2)};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  envRow: css`
    display: flex;
    gap: ${theme.spacing(2)};
    align-items: flex-end;
    margin-bottom: ${theme.spacing(1)};
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
