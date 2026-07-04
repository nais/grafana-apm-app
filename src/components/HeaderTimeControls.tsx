import React, { useCallback, useMemo } from 'react';
import { TimeRangePicker } from '@grafana/ui';
import { rangeUtil, isDateTime, DateTime, TimeRange } from '@grafana/data';
import { TimeZone } from '@grafana/schema';
import { useTimeRange } from '../utils/timeRange';
import { useUrlParams } from '../utils/useUrlState';
import { RefreshControl } from './RefreshControl';

/**
 * The one universal time control for a service page: a Grafana TimeRangePicker
 * plus the house RefreshControl, both wired to the shared from/to URL params
 * (utils/timeRange). Replaces the per-tab SceneTimePicker/SceneRefreshPicker
 * and IssuesTab's interim quick-range combobox so every tab reads one window.
 *
 * Relative expressions (now-1h) are stored verbatim in the URL — exactly as
 * useTimeRange already persists them — so a refresh re-resolves them to fresh
 * timestamps. Absolute picks and move/zoom freeze the window as ISO strings
 * (dateMath.toDateTime, which useTimeRange resolves with, parses ISO_8601).
 * Every write goes through useUrlParams so from+to land in ONE atomic URL
 * transaction (one history entry).
 */

/** Grafana raw range endpoints are DateTime (absolute) or string (relative). */
function rawToUrlValue(v: DateTime | string): string {
  return isDateTime(v) ? v.toISOString() : v;
}

export function HeaderTimeControls() {
  const { from, to, fromMs, toMs, refresh } = useTimeRange();
  const setParams = useUrlParams();

  // Re-resolve on every fromMs/toMs change so a refresh tick keeps the picker's
  // resolved value current for relative ranges (the raw text is unchanged).
  const value: TimeRange = useMemo(
    () => rangeUtil.convertRawToRange({ from, to }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [from, to, fromMs, toMs]
  );

  const onChange = useCallback(
    (next: TimeRange) => {
      setParams({ from: rawToUrlValue(next.raw.from), to: rawToUrlValue(next.raw.to) });
    },
    [setParams]
  );

  // Move/zoom operate on the resolved window and freeze it as absolute ISO.
  const shift = useCallback(
    (deltaSpans: number) => {
      const span = toMs - fromMs;
      setParams({
        from: new Date(fromMs + deltaSpans * span).toISOString(),
        to: new Date(toMs + deltaSpans * span).toISOString(),
      });
    },
    [fromMs, toMs, setParams]
  );

  const onMoveBackward = useCallback(() => shift(-1), [shift]);
  const onMoveForward = useCallback(() => shift(1), [shift]);

  const onZoom = useCallback(() => {
    const span = toMs - fromMs;
    const mid = (fromMs + toMs) / 2;
    setParams({
      from: new Date(mid - span).toISOString(),
      to: new Date(mid + span).toISOString(),
    });
  }, [fromMs, toMs, setParams]);

  // The app does not track a time zone in the URL; the picker renders in the
  // viewer's browser zone. Accept the callback to satisfy the API, no-op it.
  const onChangeTimeZone = useCallback((_tz: TimeZone) => {}, []);

  return (
    <>
      <TimeRangePicker
        value={value}
        onChange={onChange}
        onChangeTimeZone={onChangeTimeZone}
        onMoveBackward={onMoveBackward}
        onMoveForward={onMoveForward}
        onZoom={onZoom}
      />
      <RefreshControl onRefresh={refresh} />
    </>
  );
}
