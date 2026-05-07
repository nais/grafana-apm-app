import React, { useEffect, useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps, PluginMeta } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { Alert, Button, Field, FieldSet, IconButton, Input, SecretInput, Combobox, useStyles2 } from '@grafana/ui';
import { testIds } from '../testIds';
import { Capabilities, getCapabilities } from '../../api/client';
import { AppPluginSettings, DsRef, EnvAwareDs, LabelOverrides } from '../../types/plugin';

interface GrafanaDataSource {
  uid: string;
  name: string;
  type: string;
  isDefault: boolean;
}

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
  labelOverrides: LabelOverrides;
  envOverrides: EnvOverride[];
  serviceAccountToken: string;
  tokenConfigured: boolean;
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
  const secureJsonFields = (plugin.meta as any).secureJsonFields as Record<string, boolean> | undefined;
  const [state, setState] = useState<State>({
    metricsUid: jsonData?.metricsDataSource?.uid || '',
    tracesUid: jsonData?.tracesDataSource?.uid || '',
    logsUid: jsonData?.logsDataSource?.uid || '',
    metricNamespace: jsonData?.metricNamespace || '',
    durationUnit: jsonData?.durationUnit || '',
    labelOverrides: jsonData?.labelOverrides ?? {},
    envOverrides: parseEnvOverrides(jsonData?.tracesDataSource, jsonData?.logsDataSource),
    serviceAccountToken: '',
    tokenConfigured: secureJsonFields?.serviceAccountToken === true,
  });
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [detecting, setDetecting] = useState(false);

  // Datasource options fetched from Grafana API
  const [promOptions, setPromOptions] = useState<Array<{ label: string; value: string; description?: string }>>([]);
  const [tempoOptions, setTempoOptions] = useState<Array<{ label: string; value: string; description?: string }>>([]);
  const [lokiOptions, setLokiOptions] = useState<Array<{ label: string; value: string; description?: string }>>([]);
  const [dsLoaded, setDsLoaded] = useState(false);
  const [envOptions, setEnvOptions] = useState<Array<{ label: string; value: string }>>([]);

  // Fetch environment options from capabilities on mount
  useEffect(() => {
    getCapabilities()
      .then((result) => {
        setCaps(result);
        if (result.environments?.length) {
          setEnvOptions(result.environments.sort().map((e) => ({ label: e, value: e })));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    getBackendSrv()
      .get('/api/datasources')
      .then((datasources: GrafanaDataSource[]) => {
        const toOption = (ds: GrafanaDataSource) => ({
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
      if (result.environments?.length) {
        setEnvOptions(result.environments.sort().map((e) => ({ label: e, value: e })));
      }
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

  const onLabelOverrideChange = (field: keyof LabelOverrides) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.trim() || undefined;
    setState((prev) => ({
      ...prev,
      labelOverrides: { ...prev.labelOverrides, [field]: value },
    }));
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
        labelOverrides: Object.values(state.labelOverrides).some(Boolean) ? state.labelOverrides : undefined,
      },
      secureJsonData: state.serviceAccountToken ? { serviceAccountToken: state.serviceAccountToken } : undefined,
    } as any);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Alert severity="info" title="Prerequisites">
        This plugin requires an{' '}
        <a href="https://opentelemetry.io/docs/collector/" target="_blank" rel="noreferrer">
          OpenTelemetry Collector
        </a>{' '}
        with the{' '}
        <a
          href="https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/spanmetricsconnector"
          target="_blank"
          rel="noreferrer"
        >
          spanmetrics connector
        </a>{' '}
        and{' '}
        <a
          href="https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/servicegraphconnector"
          target="_blank"
          rel="noreferrer"
        >
          servicegraph connector
        </a>{' '}
        writing to Mimir, Tempo, and Loki. Without span metrics, the plugin cannot display request rates, error rates,
        or latency data.
      </Alert>

      <FieldSet label="Data Sources" className={s.marginTop}>
        <p className={s.description}>
          Connect the plugin to your observability stack. <strong>Metrics</strong> is required — it provides span
          metrics (request rates, errors, latency) and service graph data from Mimir. <strong>Traces</strong> and{' '}
          <strong>Logs</strong> enable drill-down from metrics to individual traces and correlated log entries.
        </p>
        <Field
          label="Metrics (Prometheus/Mimir)"
          description="Stores span metrics and service graph data generated by the OTel Collector. This is the primary datasource — all dashboards depend on it."
        >
          {dsLoaded && promOptions.length > 0 ? (
            <Combobox
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
        <Field
          label="Traces (Tempo)"
          description="Enables trace drill-down from the service overview. Click any operation or endpoint to view matching traces in Tempo."
        >
          {dsLoaded && tempoOptions.length > 0 ? (
            <Combobox
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
        <Field
          label="Logs (Loki)"
          description="Enables correlated log viewing. The Logs tab shows application logs filtered by service, and frontend metrics are queried from Loki when available."
        >
          {dsLoaded && lokiOptions.length > 0 ? (
            <Combobox
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
          For multi-cluster setups where each environment (e.g., dev, prod) has its own Tempo and Loki instances. When a
          user filters by environment, traces and logs route to the matching datasource automatically. Metrics are
          always read from the single Mimir instance above since span metrics are typically aggregated across
          environments. The environment name must match the values shown in the environment dropdown (derived from the{' '}
          <code>deployment_environment</code> label in your OTel data).
        </p>
        {state.envOverrides.map((ov, idx) => (
          <div key={idx} className={s.envRow}>
            <Field label="Environment">
              {envOptions.length > 0 ? (
                <Combobox
                  options={envOptions}
                  value={ov.env || null}
                  onChange={(v) =>
                    setState((prev) => {
                      const overrides = [...prev.envOverrides];
                      overrides[idx] = { ...overrides[idx], env: v?.value ?? '' };
                      return { ...prev, envOverrides: overrides };
                    })
                  }
                  width={20}
                  placeholder="Select environment..."
                />
              ) : (
                <Input width={20} value={ov.env} placeholder="e.g., prod" onChange={onEnvChange(idx, 'env')} />
              )}
            </Field>
            <Field label="Tempo">
              {dsLoaded && tempoOptions.length > 0 ? (
                <Combobox
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
                <Combobox
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

      <FieldSet label="Authentication" className={s.marginTop}>
        <p className={s.description}>
          The plugin backend queries datasources through Grafana&apos;s internal API on <code>localhost</code>. When
          Grafana runs behind an OAuth2 proxy (e.g., Wonderwall on Nais), the browser&apos;s session cookie belongs to
          the proxy — not to Grafana — so the backend cannot authenticate using forwarded headers alone.
        </p>
        <p className={s.description}>
          <strong>Recommended:</strong> Enable Grafana&apos;s <code>externalServiceAccounts</code> feature toggle and
          set <code>auth.managed_service_accounts_enabled = true</code>. The plugin will then authenticate automatically
          with zero configuration. See the{' '}
          <a
            href="https://grafana.com/developers/plugin-tools/how-to-guides/app-plugins/use-a-service-account"
            target="_blank"
            rel="noreferrer"
          >
            Grafana docs
          </a>
          .
        </p>
        <p className={s.description}>
          <strong>Fallback:</strong> If the feature toggle is not available, manually create a{' '}
          <a href="/org/serviceaccounts" target="_blank" rel="noreferrer">
            service account
          </a>{' '}
          and paste its token below. <strong>Not needed</strong> for local development with anonymous auth or when
          Grafana handles authentication directly.
        </p>
        <Field
          label="Grafana Service Account Token"
          description={
            <>
              Create a{' '}
              <a href="/org/serviceaccounts" target="_blank" rel="noreferrer">
                service account
              </a>{' '}
              with <strong>Viewer</strong> role. The token only needs read access to the configured datasources.
            </>
          }
        >
          <SecretInput
            width={40}
            isConfigured={state.tokenConfigured}
            value={state.serviceAccountToken}
            placeholder="glsa_..."
            onChange={(e) => setState((prev) => ({ ...prev, serviceAccountToken: e.currentTarget.value }))}
            onReset={() => setState((prev) => ({ ...prev, serviceAccountToken: '', tokenConfigured: false }))}
          />
        </Field>
      </FieldSet>

      <FieldSet label="Detection & Overrides" className={s.marginTop}>
        <p className={s.description}>
          The plugin auto-detects your OTel Collector&apos;s metric naming convention by probing Mimir for known span
          metric names (e.g., <code>traces_spanmetrics_calls_total</code>). Use the overrides below only if
          auto-detection picks the wrong namespace or duration unit.
        </p>
        <div className={s.detectRow}>
          <Button variant="secondary" onClick={onAutoDetect} disabled={detecting}>
            {detecting ? 'Detecting...' : 'Auto-detect capabilities'}
          </Button>
        </div>

        {caps && !caps.spanMetrics.detected && (
          <Alert severity="warning" title="No span metrics detected" className={s.marginTop}>
            Could not find span metrics in the configured Mimir datasource. Verify that the OTel Collector&apos;s
            spanmetrics connector is running and writing to Mimir, and that the service account token (if required) has
            read access.
          </Alert>
        )}

        {caps?.spanMetrics.detected && (
          <Alert severity="success" title="Span metrics detected" className={s.marginTop}>
            Namespace: <strong>{caps.spanMetrics.namespace || '(none)'}</strong>, Duration unit:{' '}
            <strong>{caps.spanMetrics.durationUnit}</strong>, Services found:{' '}
            <strong>{caps.services?.length ?? 0}</strong>
            {caps.serviceGraph?.detected && (
              <div style={{ marginTop: 4 }}>
                Service graph: <strong>{caps.serviceGraph.prefix}</strong> ✓
              </div>
            )}
            {caps.tempo && (
              <div style={{ marginTop: 4 }}>
                Tempo: {caps.tempo.available ? '✓ connected' : `✗ ${caps.tempo.error}`}
              </div>
            )}
            {caps.loki && (
              <div style={{ marginTop: 4 }}>Loki: {caps.loki.available ? '✓ connected' : `✗ ${caps.loki.error}`}</div>
            )}
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

        <Field
          label="Metric Namespace"
          description="The prefix used by your spanmetrics connector (e.g., traces_spanmetrics, spanmetrics). Leave empty to auto-detect."
          className={s.marginTop}
        >
          <Input
            width={40}
            value={state.metricNamespace}
            placeholder="auto-detect"
            onChange={onChange('metricNamespace')}
          />
        </Field>
        <Field
          label="Duration Unit"
          description="Whether your span duration histograms use milliseconds or seconds. Leave empty to auto-detect."
        >
          <Input width={20} value={state.durationUnit} placeholder="auto-detect" onChange={onChange('durationUnit')} />
        </Field>

        <Field
          label="Service Name Label"
          description='Prometheus label for the service name. Default: "service_name". Tempo metrics generator emits "service".'
          className={s.marginTop}
        >
          <Input
            width={40}
            value={state.labelOverrides.serviceNameLabel || ''}
            placeholder="service_name"
            onChange={onLabelOverrideChange('serviceNameLabel')}
          />
        </Field>
        <Field
          label="Service Namespace Label"
          description='Prometheus label for the service namespace. Default: "service_namespace".'
        >
          <Input
            width={40}
            value={state.labelOverrides.serviceNamespaceLabel || ''}
            placeholder="service_namespace"
            onChange={onLabelOverrideChange('serviceNamespaceLabel')}
          />
        </Field>
        <Field
          label="Deployment Environment Label"
          description='Prometheus label for the deployment environment. Default: "k8s_cluster_name".'
        >
          <Input
            width={40}
            value={state.labelOverrides.deploymentEnvLabel || ''}
            placeholder="k8s_cluster_name"
            onChange={onLabelOverrideChange('deploymentEnvLabel')}
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
