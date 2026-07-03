import React, { Suspense, lazy } from 'react';
import { AppPlugin, type AppRootProps, PluginExtensionPoints, type PluginExtensionPanelContext } from '@grafana/data';
import type { DataQuery } from '@grafana/schema';

import type { AppConfigProps } from './components/AppConfig/AppConfig';
import { initDatasourceConfig } from './utils/datasources';
import { PLUGIN_BASE_URL, ROUTES } from './constants';
import { otel } from './otelconfig';

// Kick off config fetch early — Grafana doesn't expose provisioned
// app jsonData via config.apps, so we need to fetch from the API.
initDatasourceConfig();

const LazyApp = lazy(() => import('./components/App/App'));
const LazyAppConfig = lazy(() => import('./components/AppConfig/AppConfig'));

const App = (props: AppRootProps) => (
  <Suspense
    fallback={<div style={{ padding: 20, color: '#8c95a5', fontFamily: 'sans-serif' }}>Loading Nais APM...</div>}
  >
    <LazyApp {...props} />
  </Suspense>
);

const AppConfig = (props: AppConfigProps) => (
  <Suspense
    fallback={<div style={{ padding: 20, color: '#8c95a5', fontFamily: 'sans-serif' }}>Loading Nais APM Config...</div>}
  >
    <LazyAppConfig {...props} />
  </Suspense>
);

/**
 * Best-effort extraction of a service (and optionally namespace) filter from the queries
 * currently shown in Explore, so the "Open in Nais APM" link extension can deep-link straight
 * to the matching service instead of the plain service list. This intentionally does a light
 * regex scan rather than a full LogQL/TraceQL/PromQL parse — it only needs to recognize our own
 * `service_name="..."` (Loki/Mimir) or `resource.service.name="..."` (TraceQL) label conventions,
 * matching the label names centralised in `otelconfig.ts`.
 */
export function extractServiceFromExploreContext(context?: PluginExtensionPanelContext): {
  service?: string;
  namespace?: string;
} {
  if (!context?.targets?.length) {
    return {};
  }

  const escapeForRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labelPattern = (label: string) => new RegExp(`${escapeForRegex(label)}\\s*=\\s*"([^"]+)"`);

  const servicePatterns = [labelPattern(otel.labels.serviceName), labelPattern(otel.traceQL.serviceName)];
  const namespacePatterns = [labelPattern(otel.labels.serviceNamespace), labelPattern(otel.traceQL.serviceNamespace)];

  for (const target of context.targets as Array<DataQuery & { expr?: string; query?: string }>) {
    const queryText = [target.expr, target.query].filter((v): v is string => typeof v === 'string').join(' ');
    if (!queryText) {
      continue;
    }
    const serviceMatch = servicePatterns.map((p) => queryText.match(p)).find((m) => m);
    if (!serviceMatch) {
      continue;
    }
    const namespaceMatch = namespacePatterns.map((p) => queryText.match(p)).find((m) => m);
    return { service: serviceMatch[1], namespace: namespaceMatch?.[1] };
  }

  return {};
}

/**
 * Configure function for the "Open in Nais APM" link extension. Targets
 * `grafana/explore/toolbar/action` — the extension point Grafana's own Explore toolbar exposes,
 * and the same point the OSS Logs/Metrics/Traces Drilldown apps register their
 * "Open in <Drilldown app>" links on (see e.g. grafana/logs-drilldown's `src/services/extensions/links.ts`).
 * Falls back to the plain services list when the current Explore query carries no recognizable
 * service label.
 */
export function configureNaisApmExploreLink(context?: PluginExtensionPanelContext) {
  const { service, namespace } = extractServiceFromExploreContext(context);
  if (!service) {
    return { path: `${PLUGIN_BASE_URL}/${ROUTES.Services}` };
  }
  return {
    path: `${PLUGIN_BASE_URL}/services/${encodeURIComponent(namespace || '_')}/${encodeURIComponent(service)}`,
  };
}

export const plugin = new AppPlugin<{}>()
  .setRootPage(App)
  .addConfigPage({
    title: 'Configuration',
    icon: 'cog',
    body: AppConfig,
    id: 'configuration',
  })
  .addLink({
    title: 'APM: Services',
    description: 'View all services and their health',
    targets: [PluginExtensionPoints.CommandPalette],
    path: '/a/nais-apm-app/services',
    icon: 'list-ul',
  })
  .addLink({
    title: 'APM: My Apps',
    description: 'View your favorite services',
    targets: [PluginExtensionPoints.CommandPalette],
    path: '/a/nais-apm-app/favorites',
    icon: 'star',
  })
  .addLink({
    title: 'Open in Nais APM',
    description: "View this service's health, traces, logs and errors in Nais APM",
    targets: [PluginExtensionPoints.ExploreToolbarAction],
    path: `${PLUGIN_BASE_URL}/${ROUTES.Services}`,
    icon: 'apps',
    configure: configureNaisApmExploreLink,
  });
