/**
 * Pure helpers for ExceptionDrawer, extracted for unit testing (#70 item 2).
 * No React, no fetch — safe to test in isolation.
 */

/** A single Faro session-timeline event (breadcrumb) as parsed from a Loki logfmt line. */
export interface Breadcrumb {
  timestampNs: string;
  kind: string;
  message: string;
  type?: string;
  value?: string;
  eventName?: string;
  eventDomain?: string;
  level?: string;
  fcp?: string;
  lcp?: string;
  cls?: string;
  inp?: string;
  ttfb?: string;
  rating?: string;
  attributes?: Record<string, string>;
}

/** A run of consecutive identical breadcrumbs, collapsed into one row with a count. */
export interface GroupedBreadcrumb {
  timestampNs: string;
  kind: string;
  message: string;
  count: number;
}

/**
 * Minimal logfmt parser for Faro/Alloy log lines: `key=value key="quoted value"`.
 * Quoted values may contain spaces and `=`; unquoted values stop at whitespace.
 * Does not unescape backslash sequences inside quotes (callers that need raw
 * newlines, e.g. stacktrace, do their own `\\n` → `\n` replacement).
 */
export function parseLogfmt(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^\s]+))/g;
  let match;
  while ((match = regex.exec(line)) !== null) {
    const key = match[1];
    const val = match[2] !== undefined ? match[2] : match[3];
    result[key] = val;
  }
  return result;
}

/** Render a human-readable summary line for a breadcrumb, specialized per kind/event. */
export function getBreadcrumbMessage(bc: Breadcrumb): string {
  if (bc.kind === 'event') {
    const name = bc.eventName ? `${bc.eventDomain ? bc.eventDomain + '/' : ''}${bc.eventName}` : 'Unknown Event';

    if (bc.eventName === 'faro.performance.resource' && bc.attributes) {
      const resUrl = bc.attributes.name || '';
      const cleaned = resUrl.split('?')[0];
      const duration = bc.attributes.duration ? `${parseInt(bc.attributes.duration, 10)}ms` : '';
      const initiator = bc.attributes.initiatorType || '';
      const cache = bc.attributes.cacheHitStatus || '';
      let sizeStr = '';
      if (bc.attributes.transferSize) {
        const bytes = parseInt(bc.attributes.transferSize, 10);
        if (bytes > 0) {
          sizeStr = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
        }
      }
      const details = [initiator, duration, sizeStr, cache].filter(Boolean).join(', ');
      return `resource: ${cleaned}${details ? ` [${details}]` : ''}`;
    }

    if (bc.eventName === 'faro.performance.navigation' && bc.attributes) {
      const pageUrl = bc.attributes.name || '';
      const cleaned = pageUrl.split('?')[0];
      const duration = bc.attributes.duration ? `${parseInt(bc.attributes.duration, 10)}ms` : '';
      return `navigation: ${cleaned}${duration ? ` [${duration}]` : ''}`;
    }

    if (bc.attributes) {
      const attrStr = Object.entries(bc.attributes)
        .map(([k, v]) => `${k}="${v}"`)
        .join(', ');
      return `${name} {${attrStr}}`;
    }
    return name;
  }
  if (bc.kind === 'measurement' && bc.type === 'web-vitals') {
    const vitals = [];
    if (bc.fcp) {
      vitals.push(`FCP=${parseFloat(bc.fcp).toFixed(0)}ms`);
    }
    if (bc.lcp) {
      vitals.push(`LCP=${parseFloat(bc.lcp).toFixed(0)}ms`);
    }
    if (bc.cls) {
      vitals.push(`CLS=${parseFloat(bc.cls).toFixed(3)}`);
    }
    if (bc.inp) {
      vitals.push(`INP=${parseFloat(bc.inp).toFixed(0)}ms`);
    }
    if (bc.ttfb) {
      vitals.push(`TTFB=${parseFloat(bc.ttfb).toFixed(0)}ms`);
    }
    const val = vitals.length > 0 ? vitals.join(', ') : 'Empty Measurement';
    return bc.rating ? `${val} [${bc.rating}]` : val;
  }
  if (bc.kind === 'exception' || bc.level === 'error') {
    return bc.message || bc.value || bc.type || 'Error';
  }
  return bc.message || bc.value || bc.type || '';
}

/** Icon name for a breadcrumb's `kind`, used in the session timeline. */
export function getBreadcrumbIcon(kind: string): string {
  if (kind === 'event') {
    return 'bolt';
  }
  if (kind === 'measurement') {
    return 'chart-line';
  }
  if (kind === 'exception' || kind === 'error') {
    return 'exclamation-triangle';
  }
  return 'file-alt';
}

/**
 * Collapse consecutive duplicate breadcrumbs (same `kind` and rendered
 * message) into a single row with a count. Breadcrumbs must already be sorted
 * chronologically — only adjacent entries are merged.
 */
export function groupBreadcrumbs(crumbs: Breadcrumb[]): GroupedBreadcrumb[] {
  const grouped: GroupedBreadcrumb[] = [];
  crumbs.forEach((crumb) => {
    const msg = getBreadcrumbMessage(crumb);
    const last = grouped[grouped.length - 1];
    if (last && last.kind === crumb.kind && last.message === msg) {
      last.count++;
    } else {
      grouped.push({
        timestampNs: crumb.timestampNs,
        kind: crumb.kind,
        message: msg,
        count: 1,
      });
    }
  });
  return grouped;
}

/** Loki nanosecond-string timestamp → local `HH:MM:SS.mmm` for the breadcrumb list. */
export function formatTimestampNs(tsNs: string): string {
  const tsMs = Math.floor(parseInt(tsNs, 10) / 1000000);
  const d = new Date(tsMs);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}

/** Join up to `max` items, appending a "(+N more)" suffix for the rest. */
export function formatListWithMore(items: string[], max = 2): string {
  if (items.length === 0) {
    return 'N/A';
  }
  if (items.length <= max) {
    return items.join(', ');
  }
  return `${items.slice(0, max).join(', ')} (+${items.length - max} more)`;
}

/** Strip a trailing "." Faro sometimes appends to captured page URLs. */
export function cleanUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  return url.endsWith('.') ? url.slice(0, -1) : url;
}
