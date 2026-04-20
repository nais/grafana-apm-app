import { urlUtil } from '@grafana/data';
import { escapeQueryString } from './sanitize';
import { otel } from '../otelconfig';

interface ExploreParams {
  datasourceUid: string;
  queries: Array<Record<string, unknown>>;
  range?: { from: string; to: string };
}

/**
 * Build a Grafana Explore URL with pre-filled query parameters.
 */
export function buildExploreUrl(params: ExploreParams): string {
  const left = JSON.stringify({
    datasource: params.datasourceUid,
    queries: params.queries,
    range: params.range ?? { from: 'now-1h', to: 'now' },
  });
  return urlUtil.renderUrl('/explore', { left });
}

/**
 * Build an Explore URL for Tempo traces filtered by service.
 */
export function buildTempoExploreUrl(
  tempoUid: string,
  serviceName: string,
  options?: {
    from?: string;
    to?: string;
    statusCode?: string;
    operation?: string;
    namespace?: string;
  }
): string {
  let query = `{${otel.traceQL.serviceName}="${escapeQueryString(serviceName)}"`;
  if (options?.namespace) {
    query += ` && ${otel.traceQL.serviceNamespace}="${escapeQueryString(options.namespace)}"`;
  }
  if (options?.statusCode) {
    query += ` && status=${options.statusCode}`;
  }
  if (options?.operation) {
    query += ` && name="${escapeQueryString(options.operation)}"`;
  }
  query += '}';

  return buildExploreUrl({
    datasourceUid: tempoUid,
    queries: [{ refId: 'A', queryType: 'traceql', query }],
    range: {
      from: options?.from ?? 'now-1h',
      to: options?.to ?? 'now',
    },
  });
}

/**
 * Build an Explore URL for Loki logs filtered by service.
 */
export function buildLokiExploreUrl(
  lokiUid: string,
  serviceName: string,
  options?: {
    from?: string;
    to?: string;
    traceId?: string;
    namespace?: string;
  }
): string {
  let expr = options?.namespace
    ? `{${otel.labels.serviceName}="${escapeQueryString(serviceName)}", ${otel.labels.serviceNamespace}="${escapeQueryString(options.namespace)}"}`
    : `{${otel.labels.serviceName}="${escapeQueryString(serviceName)}"}`;
  if (options?.traceId) {
    expr += ` |= "${escapeQueryString(options.traceId)}"`;
  }

  return buildExploreUrl({
    datasourceUid: lokiUid,
    queries: [{ refId: 'A', expr }],
    range: {
      from: options?.from ?? 'now-1h',
      to: options?.to ?? 'now',
    },
  });
}

/**
 * Build an Explore URL for Mimir/Prometheus metrics.
 */
export function buildMimirExploreUrl(
  mimirUid: string,
  expr: string,
  options?: { from?: string; to?: string }
): string {
  return buildExploreUrl({
    datasourceUid: mimirUid,
    queries: [{ refId: 'A', expr }],
    range: {
      from: options?.from ?? 'now-1h',
      to: options?.to ?? 'now',
    },
  });
}
