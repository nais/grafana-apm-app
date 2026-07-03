import {
  parseLogfmt,
  getBreadcrumbMessage,
  getBreadcrumbIcon,
  groupBreadcrumbs,
  formatTimestampNs,
  formatListWithMore,
  cleanUrl,
  Breadcrumb,
} from './exception-utils';

describe('parseLogfmt', () => {
  // A realistic Faro/Alloy frontend-exception line as it lands in Loki: stream
  // labels + logfmt fields, matching the field names ExceptionDrawer maps
  // onto ParsedException (see otel.faroLoki in src/otelconfig.ts).
  const faroExceptionLine =
    'kind=exception hash=1a2b3c4d service_name=my-service app_name=my-app app_namespace=team-a ' +
    'app_version=1.4.2 app_environment=production browser_name=Chrome browser_version=126.0.0.0 ' +
    'browser_os="macOS 10.15.7" page_url=https://example.com/checkout page_id=/checkout ' +
    'session_id=01958f3a-1234-7890-abcd-ef0123456789 user_id=42 user_username=jdoe ' +
    'user_email=jane.doe@example.com type=TypeError value="Cannot read properties of undefined (reading foo) code=500" ' +
    'stacktrace="TypeError: Cannot read properties of undefined (reading foo)\\n    at Object.<anonymous> (/app/src/checkout.ts:42:10)" ' +
    'timestamp=2026-07-03T10:15:22.100Z empty_field=""';

  const parsed = parseLogfmt(faroExceptionLine);

  it('parses unquoted scalar fields', () => {
    expect(parsed.kind).toBe('exception');
    expect(parsed.hash).toBe('1a2b3c4d');
    expect(parsed.service_name).toBe('my-service');
    expect(parsed.app_version).toBe('1.4.2');
    expect(parsed.user_id).toBe('42');
  });

  it('parses quoted values containing spaces', () => {
    expect(parsed.browser_os).toBe('macOS 10.15.7');
  });

  it('parses quoted values containing embedded equals signs and spaces', () => {
    expect(parsed.value).toBe('Cannot read properties of undefined (reading foo) code=500');
  });

  it('parses quoted values containing literal (escaped) newlines', () => {
    expect(parsed.stacktrace).toContain('at Object.<anonymous> (/app/src/checkout.ts:42:10)');
    expect(parsed.stacktrace).toContain('\\n');
  });

  it('parses an explicit empty quoted value as an empty string', () => {
    expect(parsed.empty_field).toBe('');
  });

  it('does not confuse a URL value (containing ":" and "/") with a new key', () => {
    expect(parsed.page_url).toBe('https://example.com/checkout');
    expect(parsed.page_id).toBe('/checkout');
  });

  it('returns an empty object for an empty line', () => {
    expect(parseLogfmt('')).toEqual({});
  });

  it('ignores keys with no matching value token', () => {
    expect(parseLogfmt('dangling_key')).toEqual({});
  });

  it('documents current behavior for backslash-escaped quotes inside a quoted value', () => {
    // The regex has no escape handling: it treats the first literal `"` as
    // the closing quote regardless of a preceding backslash, so an escaped
    // quote truncates the captured value. This is a characterization test
    // of existing behavior, not a spec — parseLogfmt was extracted verbatim
    // (zero behavior change) as part of #70 item 2.
    const result = parseLogfmt('msg="he said \\"hi\\" to me"');
    expect(result.msg).toBe('he said \\');
  });
});

describe('formatTimestampNs', () => {
  // Fixed epoch-ms values (not "now") so the ms/1e6 round trip through
  // parseInt is deterministic regardless of when the suite runs — the
  // nanosecond value is a 19-digit number, past Number.MAX_SAFE_INTEGER, so
  // not every millisecond survives the round trip exactly. The expected
  // string is derived from the same Date getters formatTimestampNs uses,
  // so the assertion holds under any local time zone.
  it.each([1700000000123, 1609459200000, 1893456000999])(
    'formats epoch-ms %d as local HH:MM:SS.mmm, zero-padded',
    (epochMs) => {
      const tsNs = `${epochMs}000000`;
      const d = new Date(epochMs);
      const expected = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
      expect(formatTimestampNs(tsNs)).toBe(expected);
      expect(formatTimestampNs(tsNs)).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    }
  );
});

describe('formatListWithMore', () => {
  it('returns "N/A" for an empty list', () => {
    expect(formatListWithMore([])).toBe('N/A');
  });

  it('joins all items when at or below the max', () => {
    expect(formatListWithMore(['a', 'b'], 2)).toBe('a, b');
    expect(formatListWithMore(['a'], 2)).toBe('a');
  });

  it('truncates and appends a "+N more" suffix beyond the max', () => {
    expect(formatListWithMore(['a', 'b', 'c', 'd'], 2)).toBe('a, b (+2 more)');
  });

  it('defaults max to 2', () => {
    expect(formatListWithMore(['a', 'b', 'c'])).toBe('a, b (+1 more)');
  });
});

describe('cleanUrl', () => {
  it('returns undefined for an undefined input', () => {
    expect(cleanUrl(undefined)).toBeUndefined();
  });

  it('strips a single trailing period', () => {
    expect(cleanUrl('https://example.com/page.')).toBe('https://example.com/page');
  });

  it('leaves a URL without a trailing period unchanged', () => {
    expect(cleanUrl('https://example.com/page')).toBe('https://example.com/page');
  });
});

describe('getBreadcrumbIcon', () => {
  it('maps known kinds to their icon', () => {
    expect(getBreadcrumbIcon('event')).toBe('bolt');
    expect(getBreadcrumbIcon('measurement')).toBe('chart-line');
    expect(getBreadcrumbIcon('exception')).toBe('exclamation-triangle');
    expect(getBreadcrumbIcon('error')).toBe('exclamation-triangle');
  });

  it('falls back to a generic icon for unknown kinds', () => {
    expect(getBreadcrumbIcon('log')).toBe('file-alt');
    expect(getBreadcrumbIcon('unknown')).toBe('file-alt');
  });
});

function crumb(overrides: Partial<Breadcrumb>): Breadcrumb {
  return { timestampNs: '1000000000', kind: 'log', message: 'hello', ...overrides };
}

describe('getBreadcrumbMessage', () => {
  it('formats a generic event with no known attributes', () => {
    expect(getBreadcrumbMessage(crumb({ kind: 'event', eventName: 'click', eventDomain: 'ui' }))).toBe('ui/click');
  });

  it('formats a resource performance event with attributes', () => {
    const bc = crumb({
      kind: 'event',
      eventName: 'faro.performance.resource',
      attributes: { name: 'https://cdn.example.com/app.js?v=2', duration: '123.7', initiatorType: 'script' },
    });
    expect(getBreadcrumbMessage(bc)).toBe('resource: https://cdn.example.com/app.js [script, 123ms]');
  });

  it('formats a navigation performance event', () => {
    const bc = crumb({
      kind: 'event',
      eventName: 'faro.performance.navigation',
      attributes: { name: 'https://example.com/page?x=1', duration: '456' },
    });
    expect(getBreadcrumbMessage(bc)).toBe('navigation: https://example.com/page [456ms]');
  });

  it('formats web-vitals measurements', () => {
    const bc = crumb({ kind: 'measurement', type: 'web-vitals', lcp: '1234.5', rating: 'good' });
    expect(getBreadcrumbMessage(bc)).toBe('LCP=1235ms [good]');
  });

  it('falls back to "Empty Measurement" when no vitals are present', () => {
    const bc = crumb({ kind: 'measurement', type: 'web-vitals' });
    expect(getBreadcrumbMessage(bc)).toBe('Empty Measurement');
  });

  it('formats exceptions using message, value or type in priority order', () => {
    expect(getBreadcrumbMessage(crumb({ kind: 'exception', message: '', value: 'boom', type: 'TypeError' }))).toBe(
      'boom'
    );
    expect(getBreadcrumbMessage(crumb({ kind: 'exception', message: '', value: '', type: 'TypeError' }))).toBe(
      'TypeError'
    );
    expect(getBreadcrumbMessage(crumb({ kind: 'log', level: 'error', message: '', value: '', type: '' }))).toBe(
      'Error'
    );
  });

  it('falls back to message/value/type for other kinds, else empty string', () => {
    expect(getBreadcrumbMessage(crumb({ kind: 'log', message: 'plain message' }))).toBe('plain message');
    expect(getBreadcrumbMessage(crumb({ kind: 'log', message: '', value: '', type: '' }))).toBe('');
  });
});

describe('groupBreadcrumbs', () => {
  it('merges consecutive duplicate kind+message pairs with a count', () => {
    const crumbs: Breadcrumb[] = [
      crumb({ timestampNs: '1', kind: 'log', message: 'ping' }),
      crumb({ timestampNs: '2', kind: 'log', message: 'ping' }),
      crumb({ timestampNs: '3', kind: 'log', message: 'ping' }),
    ];
    const grouped = groupBreadcrumbs(crumbs);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ timestampNs: '1', kind: 'log', message: 'ping', count: 3 });
  });

  it('does not merge non-consecutive duplicates', () => {
    const crumbs: Breadcrumb[] = [
      crumb({ timestampNs: '1', kind: 'log', message: 'ping' }),
      crumb({ timestampNs: '2', kind: 'log', message: 'other' }),
      crumb({ timestampNs: '3', kind: 'log', message: 'ping' }),
    ];
    const grouped = groupBreadcrumbs(crumbs);
    expect(grouped).toHaveLength(3);
    expect(grouped.map((g) => g.count)).toEqual([1, 1, 1]);
  });

  it('does not merge duplicates that differ only by kind', () => {
    const crumbs: Breadcrumb[] = [
      crumb({ timestampNs: '1', kind: 'log', message: 'ping' }),
      crumb({ timestampNs: '2', kind: 'error', message: 'ping' }),
    ];
    const grouped = groupBreadcrumbs(crumbs);
    expect(grouped).toHaveLength(2);
  });

  it('returns an empty array for no breadcrumbs', () => {
    expect(groupBreadcrumbs([])).toEqual([]);
  });
});
