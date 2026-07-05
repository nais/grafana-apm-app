import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { API, PushErrorOptions } from '@grafana/faro-web-sdk';

import { CONSOLE_ERROR_PREFIX, NaisConsoleInstrumentation } from './console.js';

type PushErrorCall = [Error, PushErrorOptions | undefined];

function createInstrumentation() {
  const pushError = vi.fn();
  const instrumentation = new NaisConsoleInstrumentation();
  // Faro injects `api` when registering instrumentations; emulate that.
  instrumentation.api = { pushError } as unknown as API;
  instrumentation.initialize();
  return { instrumentation, pushError };
}

describe('NaisConsoleInstrumentation', () => {
  const nativeConsoleError = console.error;
  let underlying: ReturnType<typeof vi.fn>;
  let active: NaisConsoleInstrumentation | undefined;

  beforeEach(() => {
    // Isolate from the real console so test output stays clean and we can
    // assert pass-through behavior.
    underlying = vi.fn();
    console.error = underlying as unknown as Console['error'];
  });

  afterEach(() => {
    active?.destroy();
    active = undefined;
    console.error = nativeConsoleError;
  });

  it('pushes the ORIGINAL error when an Error is the second argument', () => {
    const { instrumentation, pushError } = createInstrumentation();
    active = instrumentation;
    const err = new Error('fetch failed');
    const originalStack = err.stack;

    console.error('[ERROR] Failed to fetch auth data.', err);

    expect(pushError).toHaveBeenCalledTimes(1);
    const [pushed, options] = pushError.mock.calls[0] as PushErrorCall;
    expect(pushed).toBe(err); // same object → Faro parses the original stack
    expect(pushed.stack).toBe(originalStack);
    expect(options?.context?.['console_message']).toBe('[ERROR] Failed to fetch auth data.');
  });

  it('finds an Error in any position and serializes the remaining args', () => {
    const { instrumentation, pushError } = createInstrumentation();
    active = instrumentation;
    const err = new TypeError('boom');

    console.error('ctx', { requestId: 42 }, err, 'tail');

    const [pushed, options] = pushError.mock.calls[0] as PushErrorCall;
    expect(pushed).toBe(err);
    expect(options?.context?.['console_message']).toBe('ctx {"requestId":42} tail');
  });

  it('pushes the first Error when multiple are present (Sentry parity)', () => {
    const { instrumentation, pushError } = createInstrumentation();
    active = instrumentation;
    const first = new Error('first');
    const second = new Error('second');

    console.error(first, second);

    const [pushed, options] = pushError.mock.calls[0] as PushErrorCall;
    expect(pushed).toBe(first);
    expect(options?.context?.['console_message']).toBe('Error: second');
  });

  it('serializes object args — never [object Object] or {}', () => {
    const { instrumentation, pushError } = createInstrumentation();
    active = instrumentation;

    console.error('Failed to fetch auth data.', { status: 401, body: { reason: 'expired' } });

    const [pushed] = pushError.mock.calls[0] as PushErrorCall;
    expect(pushed.message).toBe(
      'console.error: Failed to fetch auth data. {"status":401,"body":{"reason":"expired"}}'
    );
    expect(pushed.message).not.toContain('[object Object]');
    expect(pushed.message).not.toContain('{}');
  });

  it('limits serialization depth to 2', () => {
    const { instrumentation, pushError } = createInstrumentation();
    active = instrumentation;

    console.error({ a: { b: { c: 'too deep' } } });

    const [pushed] = pushError.mock.calls[0] as PushErrorCall;
    expect(pushed.message).toBe('console.error: {"a":{"b":"[Object]"}}');
  });

  it('handles circular structures', () => {
    const { instrumentation, pushError } = createInstrumentation();
    active = instrumentation;
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;

    console.error(circular);

    const [pushed] = pushError.mock.calls[0] as PushErrorCall;
    expect(pushed.message).toBe('console.error: {"name":"loop","self":"[Circular]"}');
  });

  it('enforces the 2 KB cap on serialized output', () => {
    const { instrumentation, pushError } = createInstrumentation();
    active = instrumentation;

    console.error('x'.repeat(5000));

    const [pushed] = pushError.mock.calls[0] as PushErrorCall;
    const serialized = pushed.message.slice(CONSOLE_ERROR_PREFIX.length);
    expect(serialized.length).toBeLessThanOrEqual(2048 + '…[truncated]'.length);
    expect(serialized.endsWith('…[truncated]')).toBe(true);
  });

  it('always calls through to the underlying console.error', () => {
    const { instrumentation } = createInstrumentation();
    active = instrumentation;
    const err = new Error('x');

    console.error('a', err);

    expect(underlying).toHaveBeenCalledTimes(1);
    expect(underlying).toHaveBeenCalledWith('a', err);
  });

  it('still calls the underlying console.error when capture throws', () => {
    const pushError = vi.fn(() => {
      throw new Error('transport exploded');
    });
    const instrumentation = new NaisConsoleInstrumentation();
    instrumentation.api = { pushError } as unknown as API;
    instrumentation.internalLogger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      prefix: '',
    } as never;
    instrumentation.initialize();
    active = instrumentation;

    expect(() => console.error('boom')).not.toThrow();
    expect(underlying).toHaveBeenCalledWith('boom');
  });

  it('is idempotent: initialize twice patches once, destroy restores', () => {
    const { instrumentation, pushError } = createInstrumentation();
    active = instrumentation;
    instrumentation.initialize(); // second call must be a no-op

    console.error('once');
    expect(pushError).toHaveBeenCalledTimes(1);
    expect(underlying).toHaveBeenCalledTimes(1);

    instrumentation.destroy();
    active = undefined;
    expect(console.error).toBe(underlying);
  });
});
