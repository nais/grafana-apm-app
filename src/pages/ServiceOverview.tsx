import React, { useCallback, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PluginPage, getAppEvents, locationService } from '@grafana/runtime';
import { useStyles2, Tab, TabsBar, Combobox, Alert, Dropdown, Menu, IconButton } from '@grafana/ui';
import { AppEvents, GrafanaTheme2, PageLayoutType } from '@grafana/data';
import { useUrlString, useUrlNumber } from '../utils/useUrlState';
import { css } from '@emotion/css';
import { HeaderTimeControls } from '../components/HeaderTimeControls';
import { useSceneTimeSync } from '../utils/useSceneTimeSync';
import { buildTempoExploreUrl, buildLokiExploreUrl } from '../utils/explore';
import { FrameworkBadge } from '../components/FrameworkBadge';
import { PageHeader } from '../components/PageHeader';
import { usePluginDatasources, useHasEnvironmentOverrides, usePluginLabelOverrides } from '../utils/datasources';
import { useTimeRange } from '../utils/timeRange';
import { useCapabilities, getMetricNames, getPyroscope } from '../utils/capabilities';
import { useAppNavigate, sanitizeParam } from '../utils/navigation';
import { useServiceData } from '../utils/useServiceData';
import { getAlertTemplate, buildAlertRuleUrl } from '../api/client';
import { buildServiceScene } from './buildServiceScene';
import { OverviewTab } from './tabs/OverviewTab';
import { IssuesTab } from './tabs/IssuesTab';
import { TracesTab } from './tabs/TracesTab';
import { LogsTab } from './tabs/LogsTab';
import { DependenciesTab } from './tabs/DependenciesTab';
import { ServerTab } from './tabs/ServerTab';
import { FrontendTab } from './tabs/FrontendTab';
import { RuntimeTab } from './tabs/RuntimeTab';
import { DatabaseTab } from './tabs/DatabaseTab';
import { ProfilingTab } from './tabs/ProfilingTab';

// 'server' is the stable URL value for the tab labeled "Endpoints" in the UI
// (#69 P7: label-only rename, url-contract.md keeps tab=server).
type TabId =
  | 'overview'
  | 'issues'
  | 'server'
  | 'frontend'
  | 'runtime'
  | 'database'
  | 'dependencies'
  | 'traces'
  | 'logs'
  | 'profiling';
const VALID_TABS: TabId[] = [
  'overview',
  'issues',
  'server',
  'frontend',
  'runtime',
  'database',
  'dependencies',
  'traces',
  'logs',
  'profiling',
];

const PERCENTILE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'P50', value: '0.50' },
  { label: 'P90', value: '0.90' },
  { label: 'P95', value: '0.95' },
  { label: 'P99', value: '0.99' },
];

function ServiceOverview() {
  const { namespace: rawNamespace = '', service = '' } = useParams<{ namespace: string; service: string }>();
  // '_' is a placeholder for services with no namespace
  const namespace = rawNamespace === '_' ? '' : rawNamespace;
  // Remount the whole page when the route points at a different service:
  // fingerprints are service-agnostic, so component-local state (optimistic
  // triage overrides, probe results, filters, pagination) carried across an
  // in-place route change would apply one service's state to another.
  return <ServiceOverviewInner key={`${namespace}/${service}`} namespace={namespace} service={service} />;
}

function ServiceOverviewInner({ namespace, service }: { namespace: string; service: string }) {
  const appNavigate = useAppNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const styles = useStyles2(getStyles);
  const envFilter = sanitizeParam(searchParams.get('environment') ?? '');
  const ds = usePluginDatasources(envFilter || undefined);
  const hasEnvOverrides = useHasEnvironmentOverrides();
  const labelOverrides = usePluginLabelOverrides();
  const { from, to, fromMs, toMs } = useTimeRange();
  const { caps } = useCapabilities();
  const metrics = getMetricNames(caps);
  // Profiling is opt-in: show the tab only when a Pyroscope datasource is
  // actually detected (production has none today, so it stays hidden).
  const pyroscope = getPyroscope(caps);
  const pyroscopeAvailable = pyroscope?.available === true;
  // Stable primitive refs for Scenes useMemo — avoids re-creating the entire
  // EmbeddedScene (and flashing panels) when object references change but
  // the underlying string values haven't.
  const metricsUid = ds.metricsUid;
  const tracesUid = ds.tracesUid;
  const logsUid = ds.logsUid;
  // Gate metric names on capabilities being loaded so the scene is never
  // built with wrong default metric names.  When caps is null the scene
  // will be null (loading state) until the /capabilities response arrives.
  const callsMetric = caps ? metrics.callsMetric : '';
  const durationBucket = caps ? metrics.durationBucket : '';
  const durationUnit = metrics.durationUnit;
  const tabParam = searchParams.get('tab') ?? '';
  // A capability-gated tab whose datasource is known-unavailable would render
  // content while its TabsBar button is hidden — fall back to Overview then.
  const tabUnavailable =
    caps != null &&
    ((['issues', 'logs'].includes(tabParam) && caps.loki?.available === false) ||
      (tabParam === 'traces' && caps.tempo?.available === false) ||
      (tabParam === 'dependencies' && caps.serviceGraph?.detected === false) ||
      (tabParam === 'profiling' && !pyroscopeAvailable));
  const activeTab: TabId = VALID_TABS.includes(tabParam as TabId) && !tabUnavailable ? (tabParam as TabId) : 'overview';
  const setActiveTab = useCallback(
    (tab: TabId) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (tab === 'overview') {
          next.delete('tab');
        } else {
          next.set('tab', tab);
        }
        return next;
      });
    },
    [setSearchParams]
  );

  // Read trace filter params (set when navigating from endpoint → traces)
  const traceSpan = searchParams.get('traceSpan') ?? '';
  const traceStatus = searchParams.get('traceStatus') ?? '';
  const traceSpanKind = searchParams.get('traceSpanKind') ?? '';

  const onViewTraces = useCallback(
    (spanName: string, status?: string, spanKindRaw?: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', 'traces');
        if (spanName) {
          next.set('traceSpan', spanName);
        } else {
          next.delete('traceSpan');
        }
        if (status) {
          next.set('traceStatus', status);
        } else {
          next.delete('traceStatus');
        }
        if (spanKindRaw) {
          next.set('traceSpanKind', spanKindRaw);
        } else {
          next.delete('traceSpanKind');
        }
        return next;
      });
    },
    [setSearchParams]
  );
  const [percentile, setPercentile] = useUrlString('percentile', '0.95');
  const [depth, setDepth] = useUrlNumber('depth', 1);

  // Track which tabs have been visited so we keep them mounted. Derived
  // during render (state-adjustment pattern) — an effect would mount the
  // newly-activated tab one render late and trip set-state-in-effect lint.
  const [visitedTabs, setVisitedTabs] = useState<Set<TabId>>(new Set(['overview']));
  if (!visitedTabs.has(activeTab)) {
    setVisitedTabs(new Set(visitedTabs).add(activeTab));
  }

  // All service data fetching is encapsulated in this hook
  const {
    framework,
    envOptions,
    hasServerSpans,
    operations,
    opsLoading,
    opsError,
    graphNodes,
    graphEdges,
    connected,
    connectedLoading,
    depsResp,
    depsLoading,
    depsError,
    health,
    healthLoading,
  } = useServiceData({ service, namespace, envFilter, fromMs, toMs, depth });

  const percentileLabel = PERCENTILE_OPTIONS.find((o) => o.value === percentile)?.label ?? 'P95';

  // Scenes for RED panels — rebuild only when actual values change (not object refs).
  // The scene is null until capabilities load (callsMetric/durationBucket are gated above).
  const scene = useMemo(
    () =>
      buildServiceScene({
        service,
        namespace,
        envFilter,
        percentile,
        percentileLabel,
        from,
        to,
        metricsUid,
        tracesUid,
        logsUid,
        callsMetric,
        durationBucket,
        durationUnit,
        hasServerSpans,
        serviceNameLabel: labelOverrides.serviceNameLabel,
        serviceNamespaceLabel: labelOverrides.serviceNamespaceLabel,
        deploymentEnvLabel: labelOverrides.deploymentEnvLabel,
      }),
    [
      service,
      namespace,
      envFilter,
      percentile,
      percentileLabel,
      from,
      to,
      metricsUid,
      tracesUid,
      logsUid,
      callsMetric,
      durationBucket,
      durationUnit,
      hasServerSpans,
      labelOverrides.serviceNameLabel,
      labelOverrides.serviceNamespaceLabel,
      labelOverrides.deploymentEnvLabel,
    ]
  );

  // Key that changes when the scene is rebuilt — forces React to unmount/remount
  // the Scenes component so it properly re-activates with the new model.
  const sceneKey = `${metricsUid}|${callsMetric}|${durationBucket}|${hasServerSpans}|${envFilter}|${percentile}`;

  // Follow the global header time range: the scene rebuilds on from/to string
  // changes, this re-resolves relative ranges in place on a refresh tick.
  useSceneTimeSync(scene, fromMs, toMs);

  const onNavigateService = useCallback(
    (name: string) => {
      appNavigate(`services/_/${encodeURIComponent(name)}`);
    },
    [appNavigate]
  );

  // "Alert on error rate" (#65): fetch the server-rendered template (uses the
  // backend-detected spanmetrics calls metric) and open Grafana's pre-filled
  // new-alert-rule form. returnTo brings the user back here after save/cancel.
  const [creatingAlert, setCreatingAlert] = useState(false);
  const onErrorRateAlert = useCallback(async () => {
    setCreatingAlert(true);
    try {
      const template = await getAlertTemplate('error-rate', {
        namespace: namespace || undefined,
        service,
        environment: envFilter || undefined,
      });
      locationService.push(buildAlertRuleUrl(template.url));
    } catch (err) {
      setCreatingAlert(false);
      getAppEvents().publish({
        type: AppEvents.alertError.name,
        payload: ['Could not prepare alert rule', err instanceof Error ? err.message : String(err)],
      });
    }
  }, [namespace, service, envFilter]);

  // Service detail pages always use Canvas layout (no plugin-level header)
  return (
    <PluginPage layout={PageLayoutType.Canvas}>
      <div className={styles.container}>
        <PageHeader
          title={
            <>
              {namespace ? `${namespace}/` : ''}
              {service}
            </>
          }
          backLabel="Services"
          onBack={() => appNavigate('services')}
          after={framework ? <FrameworkBadge framework={framework} /> : undefined}
          controls={
            <>
              {activeTab === 'overview' && (
                <>
                  <label className={styles.controlLabel}>Percentile:</label>
                  <Combobox
                    options={PERCENTILE_OPTIONS}
                    value={percentile}
                    onChange={(v) => setPercentile(v.value ?? '0.95')}
                    width={10}
                  />
                </>
              )}
              {envOptions.length > 1 && (
                <Combobox
                  options={[{ label: 'All environments', value: '' }, ...envOptions]}
                  value={envFilter}
                  onChange={(v) => {
                    const next = new URLSearchParams(searchParams);
                    if (v.value) {
                      next.set('environment', v.value);
                    } else {
                      next.delete('environment');
                    }
                    setSearchParams(next, { replace: true });
                  }}
                  width={20}
                  placeholder="Environment"
                />
              )}
              <HeaderTimeControls />
              {/* Secondary actions live in a kebab so the header holds one
                  line at 1280px now that the time picker owns the width. */}
              <Dropdown
                overlay={
                  <Menu>
                    {caps?.tempo?.available !== false && (
                      <Menu.Item
                        label="Open traces in Explore"
                        icon="compass"
                        url={buildTempoExploreUrl(ds.tracesUid, service, { namespace })}
                      />
                    )}
                    {caps?.loki?.available !== false && (
                      <Menu.Item
                        label="Open logs in Explore"
                        icon="document-info"
                        url={buildLokiExploreUrl(ds.logsUid, service, {
                          namespace,
                          serviceNameLabel: labelOverrides.serviceNameLabel,
                          serviceNamespaceLabel: labelOverrides.serviceNamespaceLabel,
                        })}
                      />
                    )}
                    <Menu.Item
                      label={creatingAlert ? 'Creating alert…' : 'Alert on error rate'}
                      icon="bell"
                      disabled={creatingAlert}
                      onClick={onErrorRateAlert}
                    />
                  </Menu>
                }
              >
                <IconButton name="ellipsis-v" aria-label="More actions" tooltip="More actions" />
              </Dropdown>
            </>
          }
        />

        {/* Tabs — hide when required datasource is unavailable */}
        <TabsBar>
          <Tab label="Overview" active={activeTab === 'overview'} onChangeTab={() => setActiveTab('overview')} />
          {caps?.loki?.available !== false && (
            <Tab label="Issues" active={activeTab === 'issues'} onChangeTab={() => setActiveTab('issues')} />
          )}
          <Tab label="Endpoints" active={activeTab === 'server'} onChangeTab={() => setActiveTab('server')} />
          <Tab label="Frontend" active={activeTab === 'frontend'} onChangeTab={() => setActiveTab('frontend')} />
          <Tab label="Runtime" active={activeTab === 'runtime'} onChangeTab={() => setActiveTab('runtime')} />
          <Tab label="Database" active={activeTab === 'database'} onChangeTab={() => setActiveTab('database')} />
          {caps?.serviceGraph?.detected !== false && (
            <Tab
              label="Dependencies"
              active={activeTab === 'dependencies'}
              onChangeTab={() => setActiveTab('dependencies')}
            />
          )}
          {caps?.tempo?.available !== false && (
            <Tab label="Traces" active={activeTab === 'traces'} onChangeTab={() => setActiveTab('traces')} />
          )}
          {caps?.loki?.available !== false && (
            <Tab label="Logs" active={activeTab === 'logs'} onChangeTab={() => setActiveTab('logs')} />
          )}
          {pyroscopeAvailable && (
            <Tab label="Profiling" active={activeTab === 'profiling'} onChangeTab={() => setActiveTab('profiling')} />
          )}
        </TabsBar>

        {/* Info banner when viewing without environment filter and env overrides are configured */}
        {!envFilter && hasEnvOverrides && (activeTab === 'traces' || activeTab === 'logs') && (
          <Alert severity="info" title="Default datasource" style={{ marginTop: 8, marginBottom: 0 }}>
            Traces and logs are shown from the default datasource. Select an environment to view data from the
            environment-specific datasource.
          </Alert>
        )}

        {/* Tab content — keep visited tabs mounted to avoid re-fetching */}
        <div className={styles.tabContent}>
          <div style={{ display: activeTab === 'overview' ? undefined : 'none' }}>
            <OverviewTab
              scene={scene}
              namespace={namespace}
              environment={envFilter || undefined}
              sceneKey={sceneKey}
              operations={operations}
              opsLoading={opsLoading}
              opsError={opsError ?? null}
              graphNodes={graphNodes}
              graphEdges={graphEdges}
              connected={connected ?? undefined}
              dependencies={depsResp?.dependencies}
              health={health}
              healthLoading={healthLoading}
              service={service}
              depth={depth}
              onDepthChange={setDepth}
              onViewAllOperations={() => setActiveTab('server')}
              onViewAllDependencies={() => setActiveTab('dependencies')}
              onViewTraces={caps?.tempo?.available !== false ? onViewTraces : undefined}
              onNavigateService={onNavigateService}
              onNavigateDependency={(depName: string, depType: string) => {
                if (depType === 'service') {
                  appNavigate(`services/_/${encodeURIComponent(depName)}`);
                } else {
                  appNavigate(`dependencies/${encodeURIComponent(depName)}`);
                }
              }}
            />
          </div>

          {visitedTabs.has('issues') && (
            <div style={{ display: activeTab === 'issues' ? undefined : 'none' }}>
              <IssuesTab service={service} namespace={namespace} environment={envFilter} />
            </div>
          )}

          {visitedTabs.has('traces') && (
            <div
              style={{
                display: activeTab === 'traces' ? 'flex' : 'none',
                flexDirection: 'column',
                flex: 1,
                minHeight: 0,
              }}
            >
              <TracesTab
                key={`${traceSpan}|${traceStatus}|${traceSpanKind}`}
                service={service}
                namespace={namespace}
                tracesUid={ds.tracesUid}
                from={from}
                to={to}
                initialSpan={traceSpan}
                initialStatus={traceStatus}
                initialSpanKind={traceSpanKind}
              />
            </div>
          )}

          {visitedTabs.has('server') && (
            <div style={{ display: activeTab === 'server' ? undefined : 'none' }}>
              <ServerTab
                service={service}
                namespace={namespace}
                fromMs={fromMs}
                toMs={toMs}
                environment={envFilter || undefined}
                onViewTraces={onViewTraces}
              />
            </div>
          )}

          {visitedTabs.has('frontend') && (
            <div style={{ display: activeTab === 'frontend' ? undefined : 'none' }}>
              <FrontendTab service={service} namespace={namespace} environment={envFilter} />
            </div>
          )}

          {visitedTabs.has('runtime') && (
            <div style={{ display: activeTab === 'runtime' ? undefined : 'none' }}>
              <RuntimeTab service={service} namespace={namespace} environment={envFilter} fromMs={fromMs} toMs={toMs} />
            </div>
          )}

          {visitedTabs.has('database') && (
            <div style={{ display: activeTab === 'database' ? undefined : 'none' }}>
              <DatabaseTab
                service={service}
                namespace={namespace}
                environment={envFilter || undefined}
                fromMs={fromMs}
                toMs={toMs}
                from={from}
                to={to}
                onViewTraces={caps?.tempo?.available !== false ? onViewTraces : undefined}
              />
            </div>
          )}

          {visitedTabs.has('dependencies') && (
            <div style={{ display: activeTab === 'dependencies' ? undefined : 'none' }}>
              <DependenciesTab
                service={service}
                callers={connected?.inbound}
                callersLoading={connectedLoading}
                dependencies={depsResp?.dependencies}
                depsLoading={depsLoading}
                depsError={depsError}
                onNavigateService={onNavigateService}
                onNavigateDependency={(name: string) => {
                  appNavigate(`dependencies/${encodeURIComponent(name)}`);
                }}
              />
            </div>
          )}

          {visitedTabs.has('logs') && (
            <div
              style={{
                display: activeTab === 'logs' ? 'flex' : 'none',
                flexDirection: 'column',
                flex: 1,
                minHeight: 0,
              }}
            >
              <LogsTab
                service={service}
                namespace={namespace}
                logsUid={ds.logsUid}
                from={from}
                to={to}
                serviceNameLabel={labelOverrides.serviceNameLabel}
                clusterFilter={!ds.isLogsEnvSpecific ? envFilter || undefined : undefined}
              />
            </div>
          )}

          {visitedTabs.has('profiling') && pyroscopeAvailable && (
            <div
              style={{
                display: activeTab === 'profiling' ? 'flex' : 'none',
                flexDirection: 'column',
                flex: 1,
                minHeight: 0,
              }}
            >
              <ProfilingTab service={service} namespace={namespace} pyroscopeUid={pyroscope?.uid ?? ''} />
            </div>
          )}
        </div>
      </div>
    </PluginPage>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 0;
  `,
  tabContent: css`
    margin-top: ${theme.spacing(2)};
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  `,
  controlLabel: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});

export default ServiceOverview;
