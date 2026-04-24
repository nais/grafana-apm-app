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
