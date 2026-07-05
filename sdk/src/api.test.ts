import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogLevel } from '@grafana/faro-web-sdk';
import type { Faro } from '@grafana/faro-web-sdk';

import {
  captureException,
  captureMessage,
  clearUser,
  setContext,
  setTag,
  setUser,
} from './api.js';
import { _resetStateForTesting, setFaroInstance } from './internal.js';

function createFakeFaro() {
  const api = {
    pushError: vi.fn(),
    pushLog: vi.fn(),
    setUser: vi.fn(),
    resetUser: vi.fn(),
  };
  return { faro: { api } as unknown as Faro, api };
}

describe('Sentry-compat API', () => {
  let api: ReturnType<typeof createFakeFaro>['api'];

  beforeEach(() => {
    _resetStateForTesting();
    const fake = createFakeFaro();
    api = fake.api;
    setFaroInstance(fake.faro);
  });

  describe('captureException', () => {
    it('pushes the error through faro.api.pushError', () => {
      const err = new Error('boom');
      captureException(err);
      expect(api.pushError).toHaveBeenCalledWith(err, undefined);
    });

    it('maps fingerprint to context.fingerprint (#62)', () => {
      const err = new Error('boom');
      captureException(err, { fingerprint: 'checkout-payment-failure' });
      expect(api.pushError).toHaveBeenCalledWith(err, {
        context: { fingerprint: 'checkout-payment-failure' },
      });
    });

    it('passes context and stringifies non-string values', () => {
      captureException(new Error('x'), { context: { form: 'step-2', attempt: 3 } });
      expect(api.pushError.mock.calls[0]?.[1]).toEqual({
        context: { form: 'step-2', attempt: '3' },
      });
    });

    it('merges module-level tags and contexts, per-call context wins', () => {
      setTag('team', 'dagpenger');
      setContext('feature', { nyFlyt: 'variant-b' });
      captureException(new Error('x'), { context: { 'feature.nyFlyt': 'override' } });
      expect(api.pushError.mock.calls[0]?.[1]).toEqual({
        context: { team: 'dagpenger', 'feature.nyFlyt': 'override' },
      });
    });

    it('coerces non-Error values', () => {
      captureException('plain string failure');
      const pushed = api.pushError.mock.calls[0]?.[0] as Error;
      expect(pushed).toBeInstanceOf(Error);
      expect(pushed.message).toBe('plain string failure');
    });

    it('is a no-op with a single warning before init()', () => {
      _resetStateForTesting();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      captureException(new Error('x'));
      captureException(new Error('y'));
      expect(api.pushError).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('captureMessage', () => {
    it('pushes a log with the mapped level', () => {
      captureMessage('deploy finished', 'warning');
      expect(api.pushLog).toHaveBeenCalledWith(['deploy finished'], {
        level: LogLevel.WARN,
        context: undefined,
      });
    });

    it('defaults to info', () => {
      captureMessage('hello');
      expect(api.pushLog.mock.calls[0]?.[1]).toMatchObject({ level: LogLevel.INFO });
    });

    it('includes module-level context', () => {
      setTag('team', 'pensjon');
      captureMessage('hi');
      expect(api.pushLog.mock.calls[0]?.[1]).toMatchObject({ context: { team: 'pensjon' } });
    });
  });

  describe('user handling', () => {
    it('setUser forwards to faro.api.setUser', () => {
      setUser({ id: 'a1b2c3', username: 'ola' });
      expect(api.setUser).toHaveBeenCalledWith({ id: 'a1b2c3', username: 'ola' });
    });

    it('setUser(null) and clearUser reset the user', () => {
      setUser(null);
      clearUser();
      expect(api.resetUser).toHaveBeenCalledTimes(2);
    });
  });

  describe('setContext', () => {
    it('removes a named context when passed null', () => {
      setContext('feature', { a: '1', b: '2' });
      setContext('feature', null);
      captureException(new Error('x'));
      expect(api.pushError).toHaveBeenCalledWith(expect.any(Error), undefined);
    });
  });
});
