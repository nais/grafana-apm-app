import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Faro } from '@grafana/faro-web-sdk';

import { captureFeedback, FEEDBACK_EVENT_NAME } from './feedback.js';
import { _resetStateForTesting, setFaroInstance } from './internal.js';

function createFakeFaro() {
  const api = { pushEvent: vi.fn() };
  return { faro: { api } as unknown as Faro, api };
}

describe('captureFeedback', () => {
  let api: ReturnType<typeof createFakeFaro>['api'];

  beforeEach(() => {
    _resetStateForTesting();
    const fake = createFakeFaro();
    api = fake.api;
    setFaroInstance(fake.faro);
  });

  it('pushes a faro.feedback event with message and default category', () => {
    captureFeedback('the export button is broken');
    expect(api.pushEvent).toHaveBeenCalledWith(FEEDBACK_EVENT_NAME, {
      message: 'the export button is broken',
      category: 'other',
    });
  });

  it('carries an explicit category', () => {
    captureFeedback('would love a dark mode', { category: 'idea' });
    expect(api.pushEvent.mock.calls[0]?.[1]).toMatchObject({ category: 'idea' });
  });

  it('scrubs fnr/email/token patterns from the message', () => {
    captureFeedback('contact me at ola@nav.no re fnr 01017012345, link ?token=secret123');
    expect(api.pushEvent.mock.calls[0]?.[1]?.message).toBe(
      'contact me at [email] re fnr [fnr], link ?token=[redacted]'
    );
  });

  it('trims surrounding whitespace', () => {
    captureFeedback('   hello there   ');
    expect(api.pushEvent.mock.calls[0]?.[1]?.message).toBe('hello there');
  });

  it('caps the message at 4000 characters', () => {
    captureFeedback('x'.repeat(5000));
    const message = api.pushEvent.mock.calls[0]?.[1]?.message as string;
    expect(message).toHaveLength(4000);
  });

  it('is a no-op for a blank/whitespace-only message', () => {
    captureFeedback('   ');
    expect(api.pushEvent).not.toHaveBeenCalled();
  });

  it('includes fingerprint only when explicitly passed', () => {
    captureFeedback('broken chart', { fingerprint: 'issue-42' });
    expect(api.pushEvent.mock.calls[0]?.[1]).toMatchObject({ fingerprint: 'issue-42' });

    api.pushEvent.mockClear();
    captureFeedback('broken chart');
    expect(api.pushEvent.mock.calls[0]?.[1]).not.toHaveProperty('fingerprint');
  });

  it('includes email only when explicitly passed and email-shaped', () => {
    captureFeedback('please follow up', { email: 'ola.nordmann@nav.no' });
    expect(api.pushEvent.mock.calls[0]?.[1]).toMatchObject({ email: 'ola.nordmann@nav.no' });
  });

  it('omits a malformed email rather than sending garbage', () => {
    captureFeedback('please follow up', { email: 'not-an-email' });
    expect(api.pushEvent.mock.calls[0]?.[1]).not.toHaveProperty('email');
  });

  it('omits email entirely when not passed', () => {
    captureFeedback('no contact info here');
    expect(api.pushEvent.mock.calls[0]?.[1]).not.toHaveProperty('email');
  });

  it('flattens context entries with a ctx_ prefix, scrubbed', () => {
    captureFeedback('feedback with context', {
      context: { page: 'checkout', note: 'seen by ola@nav.no' },
    });
    expect(api.pushEvent.mock.calls[0]?.[1]).toMatchObject({
      ctx_page: 'checkout',
      ctx_note: 'seen by [email]',
    });
  });

  it('produces the full expected attrs shape', () => {
    captureFeedback('shape check', {
      category: 'bug',
      email: 'ola@nav.no',
      fingerprint: 'issue-1',
      context: { step: '2' },
    });
    expect(api.pushEvent).toHaveBeenCalledWith(FEEDBACK_EVENT_NAME, {
      message: 'shape check',
      category: 'bug',
      email: 'ola@nav.no',
      fingerprint: 'issue-1',
      ctx_step: '2',
    });
  });

  it('is a no-op with a single warning before init()', () => {
    _resetStateForTesting();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    captureFeedback('first');
    captureFeedback('second');
    expect(api.pushEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
