import { describe, expect, it, vi } from 'vitest';
import { TransportItemType } from '@grafana/faro-web-sdk';
import type { ExceptionEvent, LogEvent, Meta, TransportItem } from '@grafana/faro-web-sdk';

import { composeBeforeSend, scrubString, scrubTransportItem } from './scrub.js';

describe('scrubString — fødselsnummer', () => {
  it('masks an fnr without a space', () => {
    expect(scrubString('user 01017012345 failed')).toBe('user [fnr] failed');
  });

  it('masks an fnr with a space between date and individual digits', () => {
    expect(scrubString('fnr: 010170 12345')).toBe('fnr: [fnr]');
  });

  it('masks D-numbers (day + 40)', () => {
    expect(scrubString('41017012345')).toBe('[fnr]');
  });

  it('masks synthetic test numbers (month + 80)', () => {
    expect(scrubString('01817012345')).toBe('[fnr]');
  });

  it('leaves 11-digit numbers with an implausible date prefix alone', () => {
    expect(scrubString('order 99999912345 shipped')).toBe('order 99999912345 shipped');
    expect(scrubString('32137012345')).toBe('32137012345');
  });

  it('leaves shorter and longer digit runs alone', () => {
    expect(scrubString('0101701234')).toBe('0101701234');
    expect(scrubString('010170123456')).toBe('010170123456');
  });
});

describe('scrubString — emails', () => {
  it('masks emails', () => {
    expect(scrubString('Contact ola.nordmann@nav.no now')).toBe('Contact [email] now');
    expect(scrubString('a+b@sub.example.co.uk!')).toBe('[email]!');
  });
});

describe('scrubString — token-bearing URLs', () => {
  it('redacts token-ish query params, keeping other params', () => {
    expect(scrubString('https://app.nav.no/cb?code=abc123&foo=bar&state=xyz')).toBe(
      'https://app.nav.no/cb?code=[redacted]&foo=bar&state=[redacted]'
    );
  });

  it('redacts access_token/id_token/token', () => {
    expect(scrubString('url?access_token=eyJhbGc&id_token=eyJ0eXA&token=t0k3n')).toBe(
      'url?access_token=[redacted]&id_token=[redacted]&token=[redacted]'
    );
  });

  it('redacts tokens in URL fragments', () => {
    expect(scrubString('https://a/cb#access_token=eyJhbGc')).toBe('https://a/cb#access_token=[redacted]');
  });

  it('redacts tokens inside stack trace strings', () => {
    const stack = 'Error: boom\n    at fetchUser (https://app.nav.no/assets/x.js?token=secret123:1:2)';
    expect(scrubString(stack)).toContain('?token=[redacted]:1:2');
  });
});

function exceptionItem(overrides: Partial<ExceptionEvent> = {}, pageUrl?: string): TransportItem<ExceptionEvent> {
  return {
    type: TransportItemType.EXCEPTION,
    payload: {
      timestamp: '2026-07-03T00:00:00Z',
      type: 'Error',
      value: 'boom',
      ...overrides,
    },
    meta: (pageUrl ? { page: { url: pageUrl } } : {}) as Meta,
  };
}

describe('scrubTransportItem', () => {
  it('scrubs the exception value', () => {
    const item = exceptionItem({ value: 'lookup failed for 01017012345 (ola@nav.no)' });
    const scrubbed = scrubTransportItem(item) as TransportItem<ExceptionEvent>;
    expect(scrubbed.payload.value).toBe('lookup failed for [fnr] ([email])');
  });

  it('scrubs stack trace frames', () => {
    const item = exceptionItem({
      stacktrace: {
        frames: [{ filename: 'https://app.nav.no/x.js?token=hemmelig', function: 'save 01017012345' }],
      },
    });
    const scrubbed = scrubTransportItem(item) as TransportItem<ExceptionEvent>;
    expect(scrubbed.payload.stacktrace?.frames[0]?.filename).toBe('https://app.nav.no/x.js?token=[redacted]');
    expect(scrubbed.payload.stacktrace?.frames[0]?.function).toBe('save [fnr]');
  });

  it('scrubs context values', () => {
    const item = exceptionItem({ context: { user: 'ola@nav.no' } });
    const scrubbed = scrubTransportItem(item) as TransportItem<ExceptionEvent>;
    expect(scrubbed.payload.context?.['user']).toBe('[email]');
  });

  it('scrubs page_url in meta', () => {
    const item = exceptionItem({}, 'https://app.nav.no/callback?code=abc&state=s3cret');
    const scrubbed = scrubTransportItem(item);
    expect(scrubbed.meta.page?.url).toBe('https://app.nav.no/callback?code=[redacted]&state=[redacted]');
  });

  it('scrubs log lines', () => {
    const item: TransportItem<LogEvent> = {
      type: TransportItemType.LOG,
      payload: {
        message: 'sent to ola@nav.no',
        level: 'info',
        timestamp: '2026-07-03T00:00:00Z',
        context: undefined,
      } as LogEvent,
      meta: {} as Meta,
    };
    const scrubbed = scrubTransportItem(item) as TransportItem<LogEvent>;
    expect(scrubbed.payload.message).toBe('sent to [email]');
  });

  it('does not mutate the original item', () => {
    const item = exceptionItem({ value: 'ola@nav.no' });
    scrubTransportItem(item);
    expect(item.payload.value).toBe('ola@nav.no');
  });
});

describe('composeBeforeSend', () => {
  it('runs the user hook first, scrubber last', () => {
    const userHook = vi.fn((item: TransportItem) => ({
      ...item,
      payload: { ...(item.payload as ExceptionEvent), value: 'user-hook saw ola@nav.no' },
    }));
    const hook = composeBeforeSend(userHook as never, false)!;
    const result = hook(exceptionItem({ value: 'original' })) as TransportItem<ExceptionEvent>;
    expect(userHook).toHaveBeenCalledOnce();
    // Value set by the user hook is still scrubbed → scrubber ran after.
    expect(result.payload.value).toBe('user-hook saw [email]');
  });

  it('lets the user hook drop items', () => {
    const hook = composeBeforeSend(() => null, false)!;
    expect(hook(exceptionItem())).toBeNull();
  });

  it('scrubs without a user hook', () => {
    const hook = composeBeforeSend(undefined, false)!;
    const result = hook(exceptionItem({ value: 'fnr 010170 12345' })) as TransportItem<ExceptionEvent>;
    expect(result.payload.value).toBe('fnr [fnr]');
  });

  it('opt-out via dangerouslyDisablePiiScrubbing returns the raw user hook', () => {
    const userHook = vi.fn((item: TransportItem) => item);
    expect(composeBeforeSend(userHook as never, true)).toBe(userHook);
    const noHook = composeBeforeSend(undefined, true);
    expect(noHook).toBeUndefined();
  });
});
