import { QUICK_TIME_RANGES } from './timeRangeOptions';

describe('QUICK_TIME_RANGES', () => {
  it('has at least 5 options', () => {
    expect(QUICK_TIME_RANGES.length).toBeGreaterThanOrEqual(5);
  });

  it('every option has label and value', () => {
    for (const opt of QUICK_TIME_RANGES) {
      expect(opt.label).toBeTruthy();
      expect(opt.value).toMatch(/^now-/);
    }
  });

  it('includes common presets', () => {
    const values = QUICK_TIME_RANGES.map((o) => o.value);
    expect(values).toContain('now-1h');
    expect(values).toContain('now-24h');
  });
});

describe('describeTimeRange', () => {
  const { describeTimeRange } = jest.requireActual('./timeRangeOptions');

  it('spells out relative now-N ranges', () => {
    expect(describeTimeRange('now-3h', 'now')).toBe('the last 3 hours');
    expect(describeTimeRange('now-1h', 'now')).toBe('the last 1 hour');
    expect(describeTimeRange('now-30m', 'now')).toBe('the last 30 minutes');
    expect(describeTimeRange('now-7d', 'now')).toBe('the last 7 days');
  });

  it('falls back for absolute or unusual ranges', () => {
    expect(describeTimeRange('1751536800000', '1751540400000')).toBe('the selected time range');
    expect(describeTimeRange('now-1h/h', 'now')).toBe('the selected time range');
  });
});
