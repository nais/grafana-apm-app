import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { dateMath, rangeUtil } from '@grafana/data';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { useTimeRange } from './timeRange';

const NOW = Date.parse('2026-11-23T16:00:00.000Z');

function renderTimeRange(params = '', defaultFrom?: string) {
  return renderHook(
    () => {
      const range = useTimeRange(defaultFrom);
      const [searchParams] = useSearchParams();
      return { ...range, searchParams };
    },
    {
      wrapper: ({ children }: { children: React.ReactNode }) =>
        React.createElement(
          MemoryRouter,
          {
            initialEntries: [`/?${params}`],
            future: { v7_startTransition: true, v7_relativeSplatPath: true },
          },
          children
        ),
    }
  );
}

describe('useTimeRange', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('resolves Console Unix millisecond links and normalizes values for Grafana consumers', () => {
    const { result } = renderTimeRange('tab=traces&from=1795442247091&to=1795443147091');
    const { from, to, fromMs, toMs, searchParams } = result.current;

    expect(fromMs).toBe(1795442247091);
    expect(toMs).toBe(1795443147091);
    expect(from).toBe(new Date(fromMs).toISOString());
    expect(to).toBe(new Date(toMs).toISOString());
    expect(dateMath.toDateTime(from, {})?.valueOf()).toBe(fromMs);
    expect(dateMath.toDateTime(to, { roundUp: true })?.valueOf()).toBe(toMs);
    const pickerRange = rangeUtil.convertRawToRange({ from, to });
    expect(pickerRange.from.valueOf()).toBe(fromMs);
    expect(pickerRange.to.valueOf()).toBe(toMs);
    expect(searchParams.get('from')).toBe('1795442247091');
    expect(searchParams.get('to')).toBe('1795443147091');
    expect(searchParams.get('tab')).toBe('traces');
  });

  it.each([
    ['0', '1000', 0, 1000],
    ['-1000', '0', -1000, 0],
    ['1795442247091', 'now', 1795442247091, NOW],
    ['2026-11-23T15:00:00.000Z', '2026-11-23T16:00:00.000Z', NOW - 3600000, NOW],
  ])('resolves from=%s and to=%s', (from, to, fromMs, toMs) => {
    const { result } = renderTimeRange(new URLSearchParams({ from, to }).toString());

    expect(result.current.fromMs).toBe(fromMs);
    expect(result.current.toMs).toBe(toMs);
  });

  it('keeps relative expressions and re-resolves them on refresh', () => {
    const { result } = renderTimeRange('from=now-15m&to=now');

    expect(result.current).toMatchObject({ from: 'now-15m', to: 'now', fromMs: NOW - 900000, toMs: NOW });

    act(() => {
      jest.setSystemTime(NOW + 60000);
      result.current.refresh();
    });

    expect(result.current).toMatchObject({
      from: 'now-15m',
      to: 'now',
      fromMs: NOW - 840000,
      toMs: NOW + 60000,
    });
  });

  it('preserves round-up semantics for relative end times', () => {
    const { result } = renderTimeRange('from=now%2Fd&to=now%2Fd');

    expect(result.current.fromMs).toBe(Date.parse('2026-11-23T00:00:00.000Z'));
    expect(result.current.toMs).toBe(Date.parse('2026-11-23T23:59:59.999Z'));
  });

  it('uses the default range when URL endpoints are absent', () => {
    const { result } = renderTimeRange();

    expect(result.current).toMatchObject({ from: 'now-1h', to: 'now', fromMs: NOW - 3600000, toMs: NOW });
  });

  it('honors a custom default range', () => {
    const { result } = renderTimeRange('', 'now-6h');

    expect(result.current.fromMs).toBe(NOW - 21600000);
  });

  it.each([
    ['invalid', 'now'],
    ['now-1h', 'invalid'],
    ['now-invalid', 'now'],
    ['999999999999999999999999', 'now'],
  ])('uses the existing fallback for invalid from=%s or to=%s', (from, to) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderTimeRange(new URLSearchParams({ from, to }).toString());

    expect(result.current.fromMs).toBe(NOW - 3600000);
    expect(result.current.toMs).toBe(NOW);
    expect(warn).toHaveBeenCalledWith('Invalid URL time range; using the last hour', { from, to });
  });

  it('updates both URL endpoints while preserving unrelated parameters', () => {
    const { result } = renderTimeRange('tab=traces&environment=test&from=now-1h&to=now');

    act(() => result.current.setTimeRange('1795442247091', '1795443147091'));

    expect(Object.fromEntries(result.current.searchParams)).toEqual({
      tab: 'traces',
      environment: 'test',
      from: '1795442247091',
      to: '1795443147091',
    });
    expect(result.current.fromMs).toBe(1795442247091);
    expect(result.current.toMs).toBe(1795443147091);
  });
});
