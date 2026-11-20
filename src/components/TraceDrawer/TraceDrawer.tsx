import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { css } from '@emotion/css';
import { Field, GrafanaTheme2, LinkModel, dateTimeFormat } from '@grafana/data';
import {
  Alert,
  ClipboardButton,
  Drawer,
  LinkButton,
  LoadingPlaceholder,
  Tab,
  TabsBar,
  TextLink,
  useStyles2,
} from '@grafana/ui';
import {
  EmbeddedScene,
  PanelBuilders,
  SceneFlexItem,
  SceneFlexLayout,
  SceneQueryRunner,
  SceneTimeRange,
  VizPanel,
} from '@grafana/scenes';
import { otel } from '../../otelconfig';
import { buildExploreUrl, buildTraceExploreUrl } from '../../utils/explore';
import { useTimeRange } from '../../utils/timeRange';
import { useUrlParams } from '../../utils/useUrlState';
import {
  SPAN_ID_PARAM,
  TRACE_ID_PARAM,
  openTraceOnClick,
  traceDrawerHref,
  validSpanId,
  validTraceId,
} from './traceLinks';
import { traceDrawerData } from './traceDrawerData';
import {
  TRACE_LOGS_MARGIN_MS,
  TraceSummary,
  buildTraceLogsQueries,
  formatTraceDuration,
  hitLineLimit,
  summarizeTrace,
  traceLookup,
} from './traceSummary';

export interface TraceDrawerProps {
  /** The environment-resolved Tempo datasource. */
  tracesUid: string;
  /** The environment-resolved Loki datasource; no Logs tab without one. */
  logsUid?: string;
  /** Loki stream label naming the service: the one the Logs tab queries. */
  logsServiceLabel?: string;
  /** For a Loki shared by environments: the label and value scoping the log streams. */
  clusterLabel?: string;
  clusterFilter?: string;
}

type DrawerTab = 'trace' | 'logs';

// Lines each logs query returns: Loki's own default, plenty for one trace.
const LOG_LINE_LIMIT = 1000;

/**
 * A trace in a side drawer over the page, the way Datadog opens one: the waterfall with span
 * details, and the trace's log lines. Opened by the `traceId` URL param (and `spanId` to focus
 * a span), so it survives a reload, Back closes it, and a copied link opens it again.
 */
export function TraceDrawer(props: TraceDrawerProps) {
  const [searchParams] = useSearchParams();
  const traceId = validTraceId(searchParams.get(TRACE_ID_PARAM));
  const spanId = validSpanId(searchParams.get(SPAN_ID_PARAM));
  if (!traceId || !props.tracesUid) {
    return null;
  }
  // Keyed on the trace: another trace gets a fresh scene, tab and summary.
  return <TraceDrawerContent key={traceId} {...props} traceId={traceId} spanId={spanId} />;
}

function TraceDrawerContent({
  tracesUid,
  logsUid,
  // The Logs tab's default: the label Faro and the log pipeline write.
  logsServiceLabel = otel.faroLoki.serviceName,
  // As the Logs tab: without a configured label, the built-in one still scopes a shared Loki.
  clusterLabel = otel.labels.deploymentEnv,
  clusterFilter,
  traceId,
  spanId,
}: TraceDrawerProps & { traceId: string; spanId: string }) {
  const styles = useStyles2(getStyles);
  const updateParams = useUrlParams();
  const { fromMs, toMs } = useTimeRange();
  const [selectedTab, setTab] = useState<DrawerTab>('trace');
  // The Logs tab can go away after the drawer opens (its Loki turns out unavailable): the trace
  // shows then, rather than an empty drawer.
  const tab: DrawerTab = selectedTab === 'logs' && !logsUid ? 'trace' : selectedTab;

  // Built once per trace: a time-range change on the page must not refetch it. Tempo looks a
  // trace up by ID whatever the range.
  const { scene, runner, panel } = useMemo(
    () => buildTraceScene(traceId, tracesUid, fromMs, toMs, spanId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [traceId, tracesUid]
  );
  const { data } = runner.useState();
  const summary = useMemo(() => summarizeTrace(data?.series?.[0]), [data]);
  const lookup = traceLookup(data);

  // Focus moves without rebuilding the scene: span links inside the trace only change `spanId`.
  useEffect(() => {
    const focused = (panel.state.options as { focusedSpanId?: string }).focusedSpanId;
    if (focused !== (spanId || undefined)) {
      // Set on the options as they are, so the panel keeps its link callbacks untouched.
      panel.setState({
        options: { ...panel.state.options, focusedSpanId: spanId || undefined } as typeof panel.state.options,
      });
    }
  }, [panel, spanId]);

  // The trace's own time, with a margin for log lines written just before and after it.
  const range = summary
    ? { from: summary.startMs - TRACE_LOGS_MARGIN_MS, to: summary.startMs + summary.durationMs + TRACE_LOGS_MARGIN_MS }
    : { from: fromMs, to: toMs };
  const exploreUrl = buildTraceExploreUrl(tracesUid, traceId, { from: String(range.from), to: String(range.to) });

  return (
    <Drawer
      title={summary?.rootName || 'Trace'}
      subtitle={<TraceHeader traceId={traceId} summary={summary} exploreUrl={exploreUrl} />}
      onClose={() => updateParams({ [TRACE_ID_PARAM]: null, [SPAN_ID_PARAM]: null })}
      closeOnMaskClick={true}
      scrollableContent={false}
      size="lg"
      tabs={
        <TabsBar>
          <Tab label="Trace" active={tab === 'trace'} onChangeTab={() => setTab('trace')} />
          {logsUid && <Tab label="Logs" active={tab === 'logs'} onChangeTab={() => setTab('logs')} />}
        </TabsBar>
      }
    >
      <div className={styles.body}>
        {lookup.status === 'not-found' && (
          <Alert severity="warning" title="Trace not found">
            Tempo has no trace {traceId}. It can take a few seconds to appear after the request ends, and is gone once
            it is past retention.
          </Alert>
        )}
        {lookup.status === 'error' && (
          <Alert severity="error" title="Could not load the trace">
            {lookup.message || 'The trace lookup failed.'}
          </Alert>
        )}
        {/* Hidden, not unmounted: back on this tab the trace is still there, not fetched again. */}
        <div
          className={styles.pane}
          style={{ display: tab === 'trace' ? undefined : 'none' }}
          data-testid="trace-drawer-trace"
        >
          <scene.Component model={scene} />
        </div>
        {tab === 'logs' && logsUid && (
          <div className={styles.pane}>
            {/* The search is scoped to the trace's services and time, so it waits for the trace
                rather than scanning the page's whole range. */}
            {summary ? (
              <TraceLogs
                traceId={traceId}
                logsUid={logsUid}
                serviceLabel={logsServiceLabel}
                services={summary.services}
                clusterLabel={clusterLabel}
                clusterFilter={clusterFilter}
                fromMs={range.from}
                toMs={range.to}
              />
            ) : lookup.status === 'loading' ? (
              <LoadingPlaceholder text="Loading the trace…" />
            ) : (
              <p className={styles.note}>
                The logs are looked up by the trace&apos;s services and time, so they need the trace to load.
              </p>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}

function buildTraceScene(traceId: string, tracesUid: string, fromMs: number, toMs: number, spanId: string) {
  const runner = new SceneQueryRunner({
    datasource: { uid: tracesUid, type: 'tempo' },
    queries: [{ refId: 'A', queryType: 'traceql', query: traceId }],
  });
  // A span reference inside the trace (parent, child, a link to another trace) refocuses the
  // drawer instead of opening Explore; a new-tab click opens it in a new tab.
  const createFocusSpanLink = (linkTraceId: string, linkSpanId: string): LinkModel<Field> => ({
    title: 'Open span',
    href: traceDrawerHref(linkTraceId, linkSpanId),
    target: '_self',
    origin: {} as Field,
    onClick: (event) => {
      if (event && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)) {
        window.open(traceDrawerHref(linkTraceId, linkSpanId), '_blank', 'noopener,noreferrer');
        return;
      }
      openTraceOnClick(linkTraceId, linkSpanId)(event);
    },
  });
  const panel: VizPanel = PanelBuilders.traces()
    .setTitle('')
    .setDisplayMode('transparent')
    .setData(runner)
    .setOption('focusedSpanId' as never, (spanId || undefined) as never)
    .setOption('createFocusSpanLink' as never, createFocusSpanLink as never)
    .build();
  const scene = new EmbeddedScene({
    $timeRange: new SceneTimeRange({ from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }),
    body: new SceneFlexLayout({
      direction: 'column',
      children: [new SceneFlexItem({ body: panel })],
    }),
  });
  return { scene, runner, panel };
}

function TraceHeader({
  traceId,
  summary,
  exploreUrl,
}: {
  traceId: string;
  summary?: TraceSummary;
  exploreUrl: string;
}) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.header}>
      <div className={styles.facts}>
        {summary && (
          <>
            <span className={styles.service}>{summary.rootService}</span>
            <span>{dateTimeFormat(summary.startMs, { format: 'MMM D, HH:mm:ss.SSS' })}</span>
            <span>{formatTraceDuration(summary.durationMs)}</span>
            <span>
              {summary.spanCount} {summary.spanCount === 1 ? 'span' : 'spans'}
            </span>
            {summary.services.length > 1 && <span>{summary.services.length} services</span>}
            {summary.errorCount > 0 && (
              <span className={styles.errors}>
                {summary.errorCount} {summary.errorCount === 1 ? 'error' : 'errors'}
              </span>
            )}
          </>
        )}
        <span className={styles.traceId}>{traceId}</span>
        <ClipboardButton
          icon="copy"
          variant="secondary"
          fill="text"
          size="sm"
          getText={() => traceId}
          tooltip="Copy trace ID"
          aria-label="Copy trace ID"
        />
      </div>
      <div className={styles.actions}>
        <ClipboardButton icon="link" variant="secondary" size="sm" getText={() => window.location.href}>
          Copy link
        </ClipboardButton>
        <LinkButton icon="compass" variant="secondary" size="sm" href={exploreUrl} target="_blank">
          Open in Explore
        </LinkButton>
      </div>
    </div>
  );
}

interface TraceLogsProps {
  traceId: string;
  logsUid: string;
  serviceLabel: string;
  services: string[];
  clusterLabel?: string;
  clusterFilter?: string;
  fromMs: number;
  toMs: number;
}

/** The trace's log lines, oldest first, across every service in the trace. */
function TraceLogs({
  traceId,
  logsUid,
  serviceLabel,
  services,
  clusterLabel,
  clusterFilter,
  fromMs,
  toMs,
}: TraceLogsProps) {
  const exprs = buildTraceLogsQueries(traceId, { serviceLabel, services, clusterLabel, clusterFilter });
  // Strings stand in for the arrays, which are new on every render.
  const exprKey = exprs.join('\n');
  const { scene, runner } = useMemo(() => {
    const runner = new SceneQueryRunner({
      datasource: { uid: logsUid, type: 'loki' },
      queries: exprs.map((expr, i) => ({
        refId: String.fromCharCode(65 + i),
        expr,
        queryType: 'range',
        direction: 'forward',
        maxLines: LOG_LINE_LIMIT,
      })),
    });
    const scene = new EmbeddedScene({
      $timeRange: new SceneTimeRange({ from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }),
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          new SceneFlexItem({
            body: PanelBuilders.logs()
              .setTitle('')
              .setDisplayMode('transparent')
              .setData(traceDrawerData(runner, traceId))
              .setOption('showTime', true)
              .setOption('wrapLogMessage', true)
              .setOption('enableLogDetails', true)
              .setOption('prettifyLogMessage', false)
              .setOption('showLabels', false)
              .setOption('showCommonLabels', false)
              .setOption('sortOrder', 'Ascending' as never)
              .build(),
          }),
        ],
      }),
    });
    return { scene, runner };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exprKey, logsUid, fromMs, toMs, traceId]);
  const { data } = runner.useState();
  // A query that hit its limit may have more: say so, and offer every line in Explore.
  const truncated = hitLineLimit(data?.series, LOG_LINE_LIMIT);

  if (exprs.length === 0) {
    return null;
  }
  const exploreUrl = buildExploreUrl({
    datasourceUid: logsUid,
    queries: exprs.map((expr, i) => ({ refId: String.fromCharCode(65 + i), expr })),
    range: { from: String(fromMs), to: String(toMs) },
  });
  return (
    <>
      {truncated && (
        <Alert severity="info" title={`Showing the first ${LOG_LINE_LIMIT.toLocaleString('en-US')} lines per query`}>
          This trace logged more than that.{' '}
          <TextLink href={exploreUrl} external>
            Open all of its lines in Explore
          </TextLink>
          .
        </Alert>
      )}
      <scene.Component model={scene} />
    </>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    height: 100%;
    min-height: 0;
  `,
  pane: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: ${theme.spacing(1)};
    margin-top: ${theme.spacing(0.5)};
  `,
  facts: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: ${theme.spacing(0.5, 1.5)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-variant-numeric: tabular-nums;
  `,
  service: css`
    color: ${theme.colors.text.primary};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  errors: css`
    color: ${theme.colors.error.text};
  `,
  traceId: css`
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
  note: css`
    color: ${theme.colors.text.secondary};
    padding: ${theme.spacing(2)};
  `,
  actions: css`
    display: flex;
    gap: ${theme.spacing(1)};
  `,
});
