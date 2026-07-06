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
/**
 * Explore URL finding traces that carry exception span events for a service
 * (#63 Phase 2). Uses TraceQL's event scope — requires Tempo >= 2.6; on older
 * Tempo the query errors visibly in Explore, which is the documented fallback
 * for a deep link (no in-product query to probe for).
 */
export function buildExceptionTracesExploreUrl(
  tempoUid: string,
  serviceName: string,
  options?: { exceptionType?: string; from?: string; to?: string }
): string {
  let query = `{${otel.traceQL.serviceName}="${escapeQueryString(serviceName)}" && event:name="exception"`;
  if (options?.exceptionType) {
    query += ` && event.exception.type="${escapeQueryString(options.exceptionType)}"`;
  }
  query += '}';
  return buildExploreUrl({
    datasourceUid: tempoUid,
    queries: [{ refId: 'A', queryType: 'traceql', query }],
    range: options?.from && options?.to ? { from: options.from, to: options.to } : undefined,
  });
}

/**
 * Explore URL that opens one specific trace by its ID in Tempo. Grafana's Tempo
 * datasource resolves a bare trace ID passed as a `traceql` query to a single
 * trace lookup — the same contract the exemplar "View trace" links use
 * (`query: '${__value.raw}', queryType: 'traceql'`). This is the jump from a
 * thin backend log line to the full trace (spans, http/db attributes, timing).
 */
export function buildTraceExploreUrl(
  tempoUid: string,
  traceId: string,
  options?: { from?: string; to?: string }
): string {
  return buildExploreUrl({
    datasourceUid: tempoUid,
    queries: [{ refId: 'A', queryType: 'traceql', query: escapeQueryString(traceId) }],
    range: options?.from && options?.to ? { from: options.from, to: options.to } : undefined,
  });
}

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
    serviceNameLabel?: string;
    serviceNamespaceLabel?: string;
  }
): string {
  const svcLabel = options?.serviceNameLabel || otel.labels.serviceName;
  const nsLabel = options?.serviceNamespaceLabel || otel.labels.serviceNamespace;
  let expr = options?.namespace
    ? `{${svcLabel}="${escapeQueryString(serviceName)}", ${nsLabel}="${escapeQueryString(options.namespace)}"}`
    : `{${svcLabel}="${escapeQueryString(serviceName)}"}`;
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
export function buildMimirExploreUrl(mimirUid: string, expr: string, options?: { from?: string; to?: string }): string {
  return buildExploreUrl({
    datasourceUid: mimirUid,
    queries: [{ refId: 'A', expr }],
    range: {
      from: options?.from ?? 'now-1h',
      to: options?.to ?? 'now',
    },
  });
}

/* -------------------------------------------------------------------------
 * Grafana Drilldown app deep links.
 *
 * Grafana >= 12 ships the OSS "Drilldown" apps preinstalled (Logs Drilldown,
 * Metrics Drilldown, Traces Drilldown) — queryless exploration UIs that are
 * generally nicer than classic /explore for a first look. These builders
 * mirror each app's own `var-` URL param scheme so links land pre-filtered
 * on the right service, exactly like the classic Explore links above.
 *
 * URL schemes verified against each app's source (2026-07):
 *  - Logs Drilldown:    github.com/grafana/logs-drilldown
 *      src/services/extensions/links.ts (UrlParameters, contextToLink,
 *      escapePrimaryLabel) + src/services/variables.ts (VAR_DATASOURCE='ds',
 *      VAR_LABELS='filters', SERVICE_NAME='service_name').
 *  - Metrics Drilldown: github.com/grafana/metrics-drilldown
 *      src/extensions/links.ts (UrlParameters: DatasourceId='var-ds',
 *      Filters='var-filters', Metric='metric') + src/shared/constants/routes.ts
 *      (ROUTES.Drilldown='drilldown').
 *  - Traces Drilldown:  github.com/grafana/traces-drilldown
 *      src/utils/links.ts (contextToLink: var-ds, var-filters as
 *      `<scope><sep><tag>|<op>|<value>`, var-metric, var-primarySignal) +
 *      src/utils/shared.ts (VAR_DATASOURCE='ds', VAR_FILTERS='filters',
 *      ROUTES.Explore='explore').
 *
 * All three apps' adhoc filter URL params share the Scenes
 * `AdHocFiltersVariableUrlSyncHandler` wire format: one `var-filters` entry
 * per filter, `key|operator|value` (pipes/commas in the value must be
 * escaped since they're used as separators).
 * ---------------------------------------------------------------------- */

/** Escape delimiter characters used by the Scenes ad hoc filter URL format (`key|operator|value`). */
function escapeDrilldownFilterValue(value: string): string {
  return value.replace(/\|/g, '__gfp__').replace(/,/g, '__gfc__');
}

/** Escape a value used as a Logs Drilldown primary-label path segment (mirrors `escapePrimaryLabel`). */
function escapeDrilldownPathValue(value: string): string {
  return encodeURIComponent(value.replace(/[/\\]/g, '-'));
}

/**
 * Build a Logs Drilldown deep link (`/a/grafana-lokiexplore-app`) filtered by service.
 */
export function buildLogsDrilldownUrl(
  dsUid: string,
  serviceName: string,
  options?: {
    from?: string;
    to?: string;
    namespace?: string;
    serviceNameLabel?: string;
    serviceNamespaceLabel?: string;
  }
): string {
  const svcLabel = options?.serviceNameLabel || otel.labels.serviceName;
  const nsLabel = options?.serviceNamespaceLabel || otel.labels.serviceNamespace;
  // Logs Drilldown special-cases the default service label as the friendlier `service` path slug;
  // any other (overridden) label is used verbatim.
  const pathLabel = svcLabel === otel.labels.serviceName ? 'service' : svcLabel;

  const filters = [`${svcLabel}|=|${escapeDrilldownFilterValue(serviceName)}`];
  if (options?.namespace) {
    filters.push(`${nsLabel}|=|${escapeDrilldownFilterValue(options.namespace)}`);
  }

  return urlUtil.renderUrl(
    `/a/grafana-lokiexplore-app/explore/${pathLabel}/${escapeDrilldownPathValue(serviceName)}/logs`,
    {
      'var-ds': dsUid,
      'var-filters': filters,
      from: options?.from ?? 'now-1h',
      to: options?.to ?? 'now',
    }
  );
}

/**
 * Build a Metrics Drilldown deep link (`/a/grafana-metricsdrilldown-app`) filtered by service.
 */
export function buildMetricsDrilldownUrl(
  mimirUid: string,
  serviceName: string,
  options?: {
    from?: string;
    to?: string;
    namespace?: string;
    metric?: string;
    serviceNameLabel?: string;
    serviceNamespaceLabel?: string;
  }
): string {
  const svcLabel = options?.serviceNameLabel || otel.labels.serviceName;
  const nsLabel = options?.serviceNamespaceLabel || otel.labels.serviceNamespace;

  const filters = [`${svcLabel}|=|${escapeDrilldownFilterValue(serviceName)}`];
  if (options?.namespace) {
    filters.push(`${nsLabel}|=|${escapeDrilldownFilterValue(options.namespace)}`);
  }

  return urlUtil.renderUrl('/a/grafana-metricsdrilldown-app/drilldown', {
    'var-ds': mimirUid,
    'var-filters': filters,
    ...(options?.metric ? { metric: options.metric } : {}),
    from: options?.from ?? 'now-1h',
    to: options?.to ?? 'now',
  });
}

/**
 * Build a Traces Drilldown deep link (`/a/grafana-exploretraces-app`) filtered by service.
 */
export function buildTracesDrilldownUrl(
  tempoUid: string,
  serviceName: string,
  options?: {
    from?: string;
    to?: string;
    namespace?: string;
    statusCode?: 'error';
  }
): string {
  const filters = [`${otel.traceQL.serviceName}|=|${escapeDrilldownFilterValue(serviceName)}`];
  if (options?.namespace) {
    filters.push(`${otel.traceQL.serviceNamespace}|=|${escapeDrilldownFilterValue(options.namespace)}`);
  }

  return urlUtil.renderUrl('/a/grafana-exploretraces-app/explore', {
    'var-ds': tempoUid,
    'var-filters': filters,
    'var-primarySignal': 'true',
    ...(options?.statusCode ? { 'var-metric': options.statusCode === 'error' ? 'errors' : 'rate' } : {}),
    from: options?.from ?? 'now-1h',
    to: options?.to ?? 'now',
  });
}
