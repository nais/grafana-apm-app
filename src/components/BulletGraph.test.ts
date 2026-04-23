import { getRating, formatVitalValue, formatTick } from './BulletGraph';

const LCP_THRESHOLDS = [
  { value: 0, color: 'green' },
  { value: 2500, color: 'orange' },
  { value: 4000, color: 'red' },
];

const CLS_THRESHOLDS = [
  { value: 0, color: 'green' },
  { value: 0.1, color: 'orange' },
  { value: 0.25, color: 'red' },
];

describe('getRating', () => {
  it('returns Good for value below first threshold', () => {
    expect(getRating(1200, LCP_THRESHOLDS)).toEqual({ label: 'Good', color: 'green' });
  });

  it('returns Good for value at zero', () => {
    expect(getRating(0, LCP_THRESHOLDS)).toEqual({ label: 'Good', color: 'green' });
  });

  it('returns Needs improvement for value at first threshold boundary', () => {
    expect(getRating(2500, LCP_THRESHOLDS)).toEqual({ label: 'Needs improvement', color: 'orange' });
  });

  it('returns Needs improvement for value between thresholds', () => {
    expect(getRating(3500, LCP_THRESHOLDS)).toEqual({ label: 'Needs improvement', color: 'orange' });
  });

  it('returns Poor for value at poor threshold', () => {
    expect(getRating(4000, LCP_THRESHOLDS)).toEqual({ label: 'Poor', color: 'red' });
  });

  it('returns Poor for value above poor threshold', () => {
    expect(getRating(8000, LCP_THRESHOLDS)).toEqual({ label: 'Poor', color: 'red' });
  });

  it('works with small decimal thresholds (CLS)', () => {
    expect(getRating(0.05, CLS_THRESHOLDS)).toEqual({ label: 'Good', color: 'green' });
    expect(getRating(0.15, CLS_THRESHOLDS)).toEqual({ label: 'Needs improvement', color: 'orange' });
    expect(getRating(0.3, CLS_THRESHOLDS)).toEqual({ label: 'Poor', color: 'red' });
  });

  it('returns empty label for insufficient thresholds', () => {
    expect(getRating(100, [{ value: 0, color: 'green' }])).toEqual({ label: '', color: 'green' });
  });
});

describe('formatVitalValue', () => {
  it('formats integer with unit', () => {
    expect(formatVitalValue(2450, 'ms')).toBe('2,450 ms');
  });

  it('formats value without unit', () => {
    expect(formatVitalValue(2450)).toBe('2,450');
  });

  it('formats with decimals', () => {
    expect(formatVitalValue(0.123, undefined, 3)).toBe('0.123');
  });

  it('pads decimals', () => {
    expect(formatVitalValue(0.1, undefined, 3)).toBe('0.100');
  });

  it('formats zero', () => {
    expect(formatVitalValue(0, 'ms')).toBe('0 ms');
  });
});

describe('formatTick', () => {
  it('converts ms ≥ 1000 to seconds', () => {
    expect(formatTick(2500, 'ms')).toBe('2.50s');
    expect(formatTick(1800, 'ms')).toBe('1.80s');
  });

  it('keeps ms < 1000 as-is', () => {
    expect(formatTick(800, 'ms')).toBe('800ms');
    expect(formatTick(200, 'ms')).toBe('200ms');
  });

  it('returns plain number without unit', () => {
    expect(formatTick(0.1)).toBe('0.1');
    expect(formatTick(0.25)).toBe('0.25');
  });
});
