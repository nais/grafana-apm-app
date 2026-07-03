/**
 * Integration test: real initializeFaro in jsdom, dev-mode (console-echo)
 * transport, replacement console instrumentation, composed scrubber.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TransportItemType } from '@grafana/faro-web-sdk';
import type { ExceptionEvent, Faro, TransportItem } from '@grafana/faro-web-sdk';

import { captureException, init } from './index.js';
import { _resetStateForTesting } from './internal.js';

function addMeta(name: string, content: string): void {
  const meta = document.createElement('meta');
  meta.setAttribute('name', name);
  meta.setAttribute('content', content);
  document.head.appendChild(meta);
}

describe('init()', () => {
  let faro: Faro;

  beforeAll(() => {
    _resetStateForTesting();
    addMeta('nais-app', 'test-app');
    addMeta('nais-cluster', 'dev-gcp');
    addMeta('nais-version', '1.0.0-test');
    // No nais-telemetry-url meta and dev-gcp WOULD derive one; force dev mode
    // via an explicit empty override is not possible, so pass no environment
    // meta lookup and let the console transport echo instead:
    faro = init({ telemetryUrl: undefined, environment: 'local' });
  });

  it('resolves app metadata from the nais meta tags', () => {
    expect(faro.metas.value.app?.name).toBe('test-app');
    expect(faro.metas.value.app?.version).toBe('1.0.0-test');
    expect(faro.metas.value.app?.environment).toBe('local');
  });

  it('registers exactly one console-error capture path', () => {
    const pushError = vi.spyOn(faro.api, 'pushError');
    const err = new Error('single capture');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    console.error('context message', err);

    expect(pushError).toHaveBeenCalledTimes(1);
    expect(pushError.mock.calls[0]?.[0]).toBe(err);
    expect(pushError.mock.calls[0]?.[1]).toEqual({
      context: { console_message: 'context message' },
    });
    pushError.mockRestore();
    debug.mockRestore();
  });

  it('warns instead of double-initializing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = init();
    expect(second).toBe(faro);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('more than once'));
  });

  it('installs the PII scrubber as a beforeSend hook', () => {
    const hooks = faro.transports.getBeforeSendHooks();
    expect(hooks.length).toBeGreaterThan(0);
    const item: TransportItem<ExceptionEvent> = {
      type: TransportItemType.EXCEPTION,
      payload: {
        timestamp: 'now',
        type: 'Error',
        value: 'user ola@nav.no with fnr 01017012345 at ?token=abc',
      },
      // Faro's session instrumentation hook drops unsampled items, so the
      // fixture must look like a sampled session.
      meta: { session: { id: 's1', attributes: { isSampled: 'true' } } },
    };
    let result: TransportItem | null = item;
    for (const hook of hooks) {
      if (result === null) {
        break;
      }
      result = hook(result);
    }
    expect((result?.payload as ExceptionEvent).value).toBe(
      'user [email] with fnr [fnr] at ?token=[redacted]'
    );
  });

  it('captureException reaches faro.api.pushError with fingerprint context', () => {
    const pushError = vi.spyOn(faro.api, 'pushError');
    const err = new Error('capture me');

    captureException(err, { fingerprint: 'group-1' });

    expect(pushError).toHaveBeenCalledWith(err, { context: { fingerprint: 'group-1' } });
    pushError.mockRestore();
  });
});
