import React, { Suspense, lazy } from 'react';
import { AppPlugin, type AppRootProps, PluginExtensionPoints } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import type { AppConfigProps } from './components/AppConfig/AppConfig';
import { initDatasourceConfig } from './utils/datasources';

// Kick off config fetch early — Grafana doesn't expose provisioned
// app jsonData via config.apps, so we need to fetch from the API.
initDatasourceConfig();

const LazyApp = lazy(() => import('./components/App/App'));
const LazyAppConfig = lazy(() => import('./components/AppConfig/AppConfig'));

const App = (props: AppRootProps) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyApp {...props} />
  </Suspense>
);

const AppConfig = (props: AppConfigProps) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyAppConfig {...props} />
  </Suspense>
);

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
  });
