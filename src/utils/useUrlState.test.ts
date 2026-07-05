import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { useUrlParams } from './useUrlState';

function wrapperWithUrl(initialUrl: string) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(MemoryRouter, { initialEntries: [initialUrl] }, children);
  };
}

/** Render useUrlParams together with a live view of the current params. */
function renderParams(initialUrl = '/') {
  return renderHook(
    () => {
      const [searchParams] = useSearchParams();
      const update = useUrlParams();
      return { update, params: Object.fromEntries(searchParams.entries()) };
    },
    { wrapper: wrapperWithUrl(initialUrl) }
  );
}

describe('useUrlParams', () => {
  it('sets multiple params in one transaction', () => {
    const { result } = renderParams('/?tab=frontend');

    act(() => {
      result.current.update({ exceptionHash: 'abc123', exceptionSessionId: 's-1' });
    });

    expect(result.current.params).toEqual({ tab: 'frontend', exceptionHash: 'abc123', exceptionSessionId: 's-1' });
  });

  it('deletes params for null, undefined, and empty string', () => {
    const { result } = renderParams('/?a=1&b=2&c=3&keep=x');

    act(() => {
      result.current.update({ a: null, b: undefined, c: '', keep: 'y' });
    });

    expect(result.current.params).toEqual({ keep: 'y' });
  });

  it('preserves unrelated params', () => {
    const { result } = renderParams('/?from=now-1h&to=now&environment=prod');

    act(() => {
      result.current.update({ exceptionHash: 'h1' });
    });

    expect(result.current.params).toEqual({
      from: 'now-1h',
      to: 'now',
      environment: 'prod',
      exceptionHash: 'h1',
    });
  });

  it('drawer lifecycle: open → switch session → close leaves params stable', () => {
    // Regression guard for the v0.13.2–v0.13.4 close/reopen loop: closing the
    // drawer must remove BOTH params atomically so no render observes
    // exceptionSessionId without exceptionHash (or vice versa).
    const { result } = renderParams('/?tab=frontend&from=now-1h');

    act(() => {
      result.current.update({ exceptionHash: 'abc123' });
    });
    expect(result.current.params.exceptionHash).toBe('abc123');

    act(() => {
      result.current.update({ exceptionSessionId: 'session-1' });
    });
    act(() => {
      result.current.update({ exceptionSessionId: 'session-2' });
    });
    expect(result.current.params.exceptionSessionId).toBe('session-2');

    act(() => {
      result.current.update({ exceptionHash: null, exceptionSessionId: null });
    });

    expect(result.current.params).toEqual({ tab: 'frontend', from: 'now-1h' });
  });

  it('documents the footgun: two separate calls in one React batch clobber each other', () => {
    // react-router's setSearchParams functional updater receives the params
    // of the LAST RENDER, not the pending update — so consecutive calls in the
    // same batch silently drop earlier changes. This is why the rule is
    // "one user action = ONE update() call carrying every change".
    const { result } = renderParams('/');

    act(() => {
      result.current.update({ a: '1' });
      result.current.update({ b: '2' });
    });

    // 'a' is lost — expected, and exactly what batching into one call avoids:
    expect(result.current.params).toEqual({ b: '2' });

    act(() => {
      result.current.update({ a: '1', b: '2' });
    });
    expect(result.current.params).toEqual({ a: '1', b: '2' });
  });
});
