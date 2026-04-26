import pluginJson from './plugin.json';

export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;

export enum ROUTES {
  Services = 'services',
  NamespaceOverview = 'namespaces/:namespace',
  StatusBoard = 'namespaces/:namespace/status',
  ServiceOverview = 'services/:namespace/:service',
  ServiceOperations = 'services/:namespace/:service/operations',
  ServiceTraces = 'services/:namespace/:service/traces',
  ServiceLogs = 'services/:namespace/:service/logs',
  ServiceServiceMap = 'services/:namespace/:service/service-map',
  Dependencies = 'dependencies',
  DependencyDetail = 'dependencies/:name',
}
