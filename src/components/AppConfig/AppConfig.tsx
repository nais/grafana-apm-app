import React, { useEffect, useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { css } from '@emotion/css';
import { AppPluginMeta, GrafanaTheme2, PluginConfigPageProps, PluginMeta } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { Alert, Button, Field, FieldSet, IconButton, Input, SecretInput, Combobox, useStyles2 } from '@grafana/ui';
import { testIds } from '../testIds';
import { Capabilities, getCapabilities, OpsWatchlistEntry } from '../../api/client';
import { AppPluginSettings, DsRef, EnvAwareDs, LabelOverrides } from '../../types/plugin';

interface GrafanaDataSource {
  uid: string;
  name: string;
  type: string;
  isDefault: boolean;
}

interface EnvOverride {
  env: string;
  prometheusUid: string;
  tempoUid: string;
  lokiUid: string;
}

type IngressAlias = {
  hostname: string;
  service: string;
};

type State = {
  metricsUid: string;
  tracesUid: string;
  logsUid: string;
  metricNamespace: string;
  durationUnit: string;
  labelOverrides: LabelOverrides;
  envOverrides: EnvOverride[];
  ingressAliases: IngressAlias[];
  opsWatchlist: OpsWatchlistEntry[];
  serviceAccountToken: string;
  tokenConfigured: boolean;
  tokenReset: boolean;
  naisApiUrl: string;
  naisApiToken: string;
  naisTokenConfigured: boolean;
  naisTokenReset: boolean;
};

function parseEnvOverrides(
  metricsDs: EnvAwareDs | undefined,
  tracesDs: EnvAwareDs | undefined,
  logsDs: EnvAwareDs | undefined
): EnvOverride[] {
  const envs = new Set<string>([
    ...Object.keys(metricsDs?.byEnvironment ?? {}),
    ...Object.keys(tracesDs?.byEnvironment ?? {}),
    ...Object.keys(logsDs?.byEnvironment ?? {}),
  ]);
  return [...envs].sort().map((env) => ({
    env,
    prometheusUid: metricsDs?.byEnvironment?.[env]?.uid || '',
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
    envOverrides: parseEnvOverrides(jsonData?.metricsDataSource, jsonData?.tracesDataSource, jsonData?.logsDataSource),
    ingressAliases: Object.entries(jsonData?.ingressAliases ?? {}).map(([hostname, service]) => ({
      hostname,
      service,
    })),
    opsWatchlist: Array.isArray(jsonData?.opsWatchlist) ? jsonData.opsWatchlist : [],
    serviceAccountToken: '',
    tokenConfigured: secureJsonFields?.serviceAccountToken === true,
    tokenReset: false,
    naisApiUrl: jsonData?.naisApiUrl || '',
    naisApiToken: '',
    naisTokenConfigured: secureJsonFields?.naisApiToken === true,
    naisTokenReset: false,
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
          if (prev.envOverrides.length === 0 && (prom.length > 1 || tempo.length > 1 || loki.length > 1)) {
            const envMap = new Map<string, { prometheusUid: string; tempoUid: string; lokiUid: string }>();
            const envPattern = /^(.+?)[-_](prometheus|mimir|tempo|loki)$/i;
            for (const ds of datasources) {
              if (ds.type !== 'tempo' && ds.type !== 'loki' && ds.type !== 'prometheus') {
                continue;
              }
              const match = ds.name.match(envPattern) || ds.uid.match(envPattern);
              if (match) {
                const env = match[1];
                const entry = envMap.get(env) || { prometheusUid: '', tempoUid: '', lokiUid: '' };
                if (ds.type === 'prometheus') {
                  entry.prometheusUid = ds.uid;
                } else if (ds.type === 'tempo') {
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
                prometheusUid: ds.prometheusUid,
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
      envOverrides: [...prev.envOverrides, { env: '', prometheusUid: '', tempoUid: '', lokiUid: '' }],
    }));
  };

  const removeEnvOverride = (idx: number) => {
    setState((prev) => ({
      ...prev,
      envOverrides: prev.envOverrides.filter((_, i) => i !== idx),
    }));
  };

  const onAliasChange = (idx: number, field: keyof IngressAlias) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setState((prev) => {
      const aliases = [...prev.ingressAliases];
      aliases[idx] = { ...aliases[idx], [field]: e.target.value.trim() };
      return { ...prev, ingressAliases: aliases };
    });
  };

  const addAlias = () => {
    setState((prev) => ({
      ...prev,
      ingressAliases: [...prev.ingressAliases, { hostname: '', service: '' }],
    }));
  };

  const removeAlias = (idx: number) => {
    setState((prev) => ({
      ...prev,
      ingressAliases: prev.ingressAliases.filter((_, i) => i !== idx),
    }));
  };

  const onWatchlistChange =
    (idx: number, field: keyof OpsWatchlistEntry) => (e: React.ChangeEvent<HTMLInputElement>) => {
      setState((prev) => {
        const list = [...prev.opsWatchlist];
        list[idx] = { ...list[idx], [field]: e.target.value.trim() };
        return { ...prev, opsWatchlist: list };
      });
    };

  const addWatchlistEntry = () => {
    setState((prev) => ({
      ...prev,
      opsWatchlist: [...prev.opsWatchlist, { namespace: '', service: '' }],
    }));
  };

  const removeWatchlistEntry = (idx: number) => {
    setState((prev) => ({
      ...prev,
      opsWatchlist: prev.opsWatchlist.filter((_, i) => i !== idx),
    }));
  };

  const onSubmit = () => {
    // Build byEnvironment maps from overrides
    const metricsByEnv: Record<string, DsRef> = {};
    const tracesByEnv: Record<string, DsRef> = {};
    const logsByEnv: Record<string, DsRef> = {};
    for (const ov of state.envOverrides) {
      if (ov.env) {
        if (ov.prometheusUid) {
          metricsByEnv[ov.env] = { uid: ov.prometheusUid, type: 'prometheus' };
        }
        if (ov.tempoUid) {
          tracesByEnv[ov.env] = { uid: ov.tempoUid, type: 'tempo' };
        }
        if (ov.lokiUid) {
          logsByEnv[ov.env] = { uid: ov.lokiUid, type: 'loki' };
        }
      }
    }

    // Build ingress alias map from rows, normalizing hostnames to match backend behavior.
    const ingressAliases: Record<string, string> = {};
    for (const alias of state.ingressAliases) {
      if (alias.hostname && alias.service) {
        const normalized = alias.hostname
          .toLowerCase()
          .replace(/\.$/, '')
          .replace(/:(443|80)$/, '');
        ingressAliases[normalized] = alias.service;
      }
    }

    // Build ops watchlist, filtering out incomplete entries
    const opsWatchlist = state.opsWatchlist.filter((e) => e.namespace && e.service);

    // Send a secret only when the user acted on it: a newly typed value updates
    // it, an explicit Reset clears it (empty string — Grafana stores it and drops
    // the key from secureJsonFields on reload). An untouched configured secret is
    // omitted so it is never overwritten.
    const secureJsonData: Record<string, string> = {};
    if (state.serviceAccountToken) {
      secureJsonData.serviceAccountToken = state.serviceAccountToken;
    } else if (state.tokenReset) {
      secureJsonData.serviceAccountToken = '';
    }
    if (state.naisApiToken) {
      secureJsonData.naisApiToken = state.naisApiToken;
    } else if (state.naisTokenReset) {
      secureJsonData.naisApiToken = '';
    }

    updatePluginAndReload(plugin.meta.id, {
      enabled,
      pinned,
      jsonData: {
        metricsDataSource: {
          uid: state.metricsUid,
          type: 'prometheus',
          ...(Object.keys(metricsByEnv).length > 0 ? { byEnvironment: metricsByEnv } : {}),
        },
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
        ingressAliases: Object.keys(ingressAliases).length > 0 ? ingressAliases : undefined,
        opsWatchlist: opsWatchlist.length > 0 ? opsWatchlist : undefined,
        naisApiUrl: state.naisApiUrl || undefined,
      },
      secureJsonData: Object.keys(secureJsonData).length > 0 ? secureJsonData : undefined,
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
        Requires an{' '}
        <a href="https://opentelemetry.io/docs/collector/" target="_blank" rel="noreferrer">
          OpenTelemetry Collector
        </a>{' '}
        running the{' '}
        <a
          href="https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/spanmetricsconnector"
          target="_blank"
          rel="noreferrer"
        >
          spanmetrics
        </a>{' '}
        and{' '}
        <a
          href="https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/servicegraphconnector"
          target="_blank"
          rel="noreferrer"
        >
          servicegraph
        </a>{' '}
        connectors writing to Mimir, Tempo, and Loki. Without span metrics the plugin cannot show rates, errors, or
        latency.
      </Alert>

      <FieldSet label="Data Sources" className={s.marginTop}>
        <p className={s.description}>
          <strong>Metrics</strong> is required (span metrics and service graph). <strong>Traces</strong> and{' '}
          <strong>Logs</strong> enable drill-down to individual traces and correlated logs.
        </p>
        <Field
          label="Metrics (Prometheus/Mimir)"
          description="Primary datasource — span metrics and service graph. All dashboards depend on it."
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
        <Field label="Traces (Tempo)" description="Enables trace drill-down from the service overview.">
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
          description="Enables the Logs tab (application logs by service) and Loki-based frontend metrics."
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
          For multi-cluster setups where each environment has its own Tempo/Loki. Filtering by environment routes traces
          and logs to the matching datasource; metrics always read from the Mimir instance above. Environment names must
          match the dropdown values (the <code>deployment_environment</code> label in your OTel data).
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
            <Field label="Prometheus">
              {dsLoaded && promOptions.length > 0 ? (
                <Combobox
                  options={promOptions}
                  value={ov.prometheusUid || null}
                  onChange={(v) =>
                    setState((prev) => {
                      const overrides = [...prev.envOverrides];
                      overrides[idx] = { ...overrides[idx], prometheusUid: v?.value ?? '' };
                      return { ...prev, envOverrides: overrides };
                    })
                  }
                  width={25}
                  placeholder="Select Prometheus..."
                  isClearable
                />
              ) : (
                <Input
                  width={25}
                  value={ov.prometheusUid}
                  placeholder="e.g., dev-gcp-mimir"
                  onChange={onEnvChange(idx, 'prometheusUid')}
                />
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

      <FieldSet label="Authentication (fallback)" className={s.marginTop}>
        <p className={s.description}>
          Normally leave this blank. On Nais, Grafana&apos;s managed service accounts authenticate the backend
          automatically. Only set a token when managed service accounts aren&apos;t available (older or non-Nais
          Grafana), or for the backend&apos;s internal datasource calls when Grafana runs behind an OAuth2 proxy.
        </p>
        <Field
          label="Grafana Service Account Token"
          description={
            <>
              Optional fallback. Create a{' '}
              <a href="/org/serviceaccounts" target="_blank" rel="noreferrer">
                service account
              </a>{' '}
              with <strong>Viewer</strong> role; the token only needs read access to the configured datasources.
            </>
          }
        >
          <SecretInput
            width={40}
            isConfigured={state.tokenConfigured}
            value={state.serviceAccountToken}
            placeholder="glsa_..."
            onChange={(e) =>
              setState((prev) => ({ ...prev, serviceAccountToken: e.currentTarget.value, tokenReset: false }))
            }
            onReset={() =>
              setState((prev) => ({ ...prev, serviceAccountToken: '', tokenConfigured: false, tokenReset: true }))
            }
          />
        </Field>
      </FieldSet>

      <FieldSet label="nais API (optional)" className={s.marginTop}>
        <p className={s.description}>
          Enables <strong>deploy/release tracking</strong> and the <strong>scorecard ownership card</strong> (team,
          Slack, repo, ingress URLs). Both no-op cleanly without a token. Requires a netpol egress rule to the nais API
          host — see{' '}
          <a
            href="https://github.com/nais/grafana-otel-plugin/blob/main/README.md#platform-dependencies"
            target="_blank"
            rel="noreferrer"
          >
            Platform dependencies
          </a>
          .
        </p>
        <Field label="nais API URL" description="nais Console GraphQL endpoint.">
          <Input
            width={40}
            value={state.naisApiUrl}
            placeholder="https://console.<tenant>.cloud.nais.io/graphql"
            onChange={onChange('naisApiUrl')}
          />
        </Field>
        <Field
          label="nais API Token"
          description="Bearer token for the nais API. Stored encrypted; only sent when you enter a new value."
        >
          <SecretInput
            width={40}
            isConfigured={state.naisTokenConfigured}
            value={state.naisApiToken}
            placeholder="nais API token"
            onChange={(e) =>
              setState((prev) => ({ ...prev, naisApiToken: e.currentTarget.value, naisTokenReset: false }))
            }
            onReset={() =>
              setState((prev) => ({ ...prev, naisApiToken: '', naisTokenConfigured: false, naisTokenReset: true }))
            }
          />
        </Field>
      </FieldSet>

      <FieldSet label="Detection & Overrides" className={s.marginTop}>
        <p className={s.description}>
          The plugin probes Mimir to auto-detect your metric naming convention. Use the overrides below only if it picks
          the wrong namespace or duration unit.
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

      <FieldSet label="Ingress Aliases" className={s.marginTop}>
        <p className={s.description}>
          Map ingress hostnames to service names so on-prem callers that reach services via nais ingress become visible
          in the caller list and service map.
        </p>
        {state.ingressAliases.map((alias, idx) => (
          <div key={idx} className={s.envRow}>
            <Field label={idx === 0 ? 'Ingress Hostname' : undefined}>
              <Input
                width={40}
                value={alias.hostname}
                placeholder="tilgangsmaskin.intern.nav.no"
                onChange={onAliasChange(idx, 'hostname')}
              />
            </Field>
            <Field label={idx === 0 ? 'Service Name' : undefined}>
              <Input
                width={30}
                value={alias.service}
                placeholder="populasjonstilgangskontroll"
                onChange={onAliasChange(idx, 'service')}
              />
            </Field>
            <IconButton name="trash-alt" tooltip="Remove alias" onClick={() => removeAlias(idx)} />
          </div>
        ))}
        <Button variant="secondary" icon="plus" size="sm" onClick={addAlias} type="button">
          Add alias
        </Button>
      </FieldSet>

      <FieldSet label="Ops Status Board" className={s.marginTop}>
        <p className={s.description}>
          Define which services appear on the{' '}
          <a href={`/a/${plugin.meta.id}/ops`} target="_blank" rel="noreferrer">
            Ops Status Board
          </a>
          . This is a shared watchlist visible to all users — any user can also edit it via the board&apos;s API.
        </p>
        {state.opsWatchlist.map((entry, idx) => (
          <div key={idx} className={s.envRow}>
            <Field label={idx === 0 ? 'Namespace' : undefined}>
              <Input
                width={25}
                value={entry.namespace}
                placeholder="namespace"
                onChange={onWatchlistChange(idx, 'namespace')}
              />
            </Field>
            <Field label={idx === 0 ? 'Service' : undefined}>
              <Input
                width={35}
                value={entry.service}
                placeholder="service-name"
                onChange={onWatchlistChange(idx, 'service')}
              />
            </Field>
            <IconButton name="trash-alt" tooltip="Remove" onClick={() => removeWatchlistEntry(idx)} />
          </div>
        ))}
        <Button variant="secondary" icon="plus" size="sm" onClick={addWatchlistEntry} type="button">
          Add service
        </Button>
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
