import { DataLink, DataLinkClickEvent } from '@grafana/data';
import { locationService } from '@grafana/runtime';
import type { MouseEvent } from 'react';

/** URL params of the trace drawer (docs/url-contract.md). */
export const TRACE_ID_PARAM = 'traceId';
export const SPAN_ID_PARAM = 'spanId';

// Tempo IDs are hex: 32 characters for a trace (search results may drop leading zeros), 16 for a
// span. Anything else in the URL is ignored rather than interpolated into TraceQL or LogQL.
const TRACE_ID_RE = /^[0-9a-f]{1,32}$/i;
const SPAN_ID_RE = /^[0-9a-f]{1,16}$/i;

export function validTraceId(value: string | null | undefined): string {
  return value && TRACE_ID_RE.test(value) ? value.toLowerCase() : '';
}

export function validSpanId(value: string | null | undefined): string {
  return value && SPAN_ID_RE.test(value) ? value.toLowerCase() : '';
}

/**
 * The trace ID as apps log it: 32 hex characters. Tempo's search results drop leading zeros,
 * which would make a line filter miss one trace in sixteen.
 */
export function fullTraceId(traceId: string): string {
  return traceId.padStart(32, '0');
}

/** Opens the trace drawer over the current page. Pushes a history entry, so Back closes it. */
export function openTraceDrawer(traceId: string, spanId?: string): void {
  const id = validTraceId(traceId);
  if (!id) {
    return;
  }
  locationService.partial({ [TRACE_ID_PARAM]: id, [SPAN_ID_PARAM]: validSpanId(spanId) || null });
}

/**
 * The current page with the drawer open on a trace: the target of a Ctrl/Cmd-click (new tab)
 * and of a copied link. `traceId` and `spanId` go in unencoded, so they may be data-link
 * templates such as `${__value.raw}`; every other param is encoded, so no `$` survives to be
 * read as a template.
 */
export function traceDrawerHref(traceId: string, spanId?: string): string {
  const location = locationService.getLocation();
  const params = new URLSearchParams(location.search);
  params.delete(TRACE_ID_PARAM);
  params.delete(SPAN_ID_PARAM);
  const rest = params.toString();
  const span = spanId ? `&${SPAN_ID_PARAM}=${spanId}` : '';
  return `${location.pathname}?${rest ? `${rest}&` : ''}${TRACE_ID_PARAM}=${traceId}${span}`;
}

/**
 * Click handler for a link to a trace (pair it with `href={traceDrawerHref(id)}`): a click opens
 * the drawer in place; a click meant for a new tab or window follows the href.
 */
export function openTraceOnClick(traceId: string, spanId?: string) {
  return (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    openTraceDrawer(traceId, spanId);
  };
}

/**
 * Data link for a trace ID cell (Tempo search results, exemplars, a log line's trace field):
 * a click opens the trace in the drawer instead of leaving for Explore. Ctrl/Cmd/Shift-click
 * follows the URL, which opens the same drawer in a new tab.
 */
export function traceIdDataLink(): DataLink {
  return {
    title: 'Open trace',
    url: traceDrawerHref('${__value.raw}'),
    onClick: (event: DataLinkClickEvent) => {
      openTraceDrawer(event.replaceVariables?.('${__value.raw}') ?? '');
    },
  };
}

/**
 * Data link for a span ID in Tempo's search results: the spans nested under each trace carry
 * their trace ID in the hidden `traceIdHidden` field. Opens the drawer focused on that span.
 */
export function spanIdDataLink(): DataLink {
  return {
    title: 'Open span',
    url: traceDrawerHref('${__data.fields.traceIdHidden}', '${__value.raw}'),
    onClick: (event: DataLinkClickEvent) => {
      const replace = event.replaceVariables;
      openTraceDrawer(replace?.('${__data.fields.traceIdHidden}') ?? '', replace?.('${__value.raw}') ?? '');
    },
  };
}

/**
 * Fields holding a trace ID: `traceID` in Tempo search results and Tempo-generated exemplars,
 * `trace_id` in exemplars named after an OTel SDK's label, and `TraceID`/`Trace`, the Loki
 * derived fields a log line's trace link comes from.
 */
export const TRACE_ID_FIELDS = ['traceID', 'trace_id', 'TraceID', 'Trace'];

interface FieldLike {
  name: string;
  type?: string;
  config?: { links?: unknown[] };
  values?: unknown[];
}

/**
 * Swaps the datasource's link on each trace ID field (and on `spanID` in Tempo's nested span
 * frames) for the drawer's. Only fields that already link to a trace are touched. This has to
 * happen in the data: a field-config override cannot replace a datasource's links, Grafana
 * appends to them, and exemplars travel as annotations, which overrides never reach.
 *
 * Tempo's nested span frames may still be in their JSON form (`schema.fields`), so both
 * shapes are handled.
 */
export function withDrawerTraceLinks<T>(frame: T): T {
  const f = frame as { fields?: FieldLike[]; schema?: { fields?: FieldLike[] } };
  const fields = f.fields ?? f.schema?.fields;
  if (!fields) {
    return frame;
  }
  const isSpans = fields.some((field) => field.name === 'traceIdHidden');
  let changed = false;
  const next = fields.map((field) => {
    const links = field.config?.links;
    if (links?.length && TRACE_ID_FIELDS.includes(field.name)) {
      changed = true;
      return { ...field, config: { ...field.config, links: [traceIdDataLink()] } };
    }
    if (links?.length && isSpans && field.name === 'spanID') {
      changed = true;
      return { ...field, config: { ...field.config, links: [spanIdDataLink()] } };
    }
    // Tempo's backend names the field `nested` and types it `other` until the frontend reads it.
    if ((field.type === 'nestedFrames' || field.name === 'nested') && Array.isArray(field.values)) {
      changed = true;
      return {
        ...field,
        values: field.values.map((frames) => (Array.isArray(frames) ? frames.map(withDrawerTraceLinks) : frames)),
      };
    }
    return field;
  });
  if (!changed) {
    return frame;
  }
  return (f.fields ? { ...f, fields: next } : { ...f, schema: { ...f.schema, fields: next } }) as T;
}
