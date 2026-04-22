import { formatDuration, formatRate, formatErrorRate } from './format';

describe('formatRate', () => {
  it('formats with 2 decimal places and req/s suffix', () => {
    expect(formatRate(1.5)).toBe('1.50 req/s');
    expect(formatRate(0)).toBe('0.00 req/s');
    expect(formatRate(123.456)).toBe('123.46 req/s');
  });
});

describe('formatErrorRate', () => {
  it('formats with 1 decimal place and % suffix', () => {
    expect(formatErrorRate(5.0)).toBe('5.0%');
    expect(formatErrorRate(0)).toBe('0.0%');
    expect(formatErrorRate(99.99)).toBe('100.0%');
    expect(formatErrorRate(0.15)).toBe('0.1%');
  });
});

describe('formatDuration', () => {
  describe('millisecond unit', () => {
    it('formats sub-millisecond as "< 1ms"', () => {
      expect(formatDuration(0.5, 'ms')).toBe('< 1ms');
    });
    it('formats milliseconds', () => {
      expect(formatDuration(42, 'ms')).toBe('42ms');
    });
    it('formats large ms values as seconds', () => {
      expect(formatDuration(1500, 'ms')).toBe('1.5s');
    });
  });

  describe('second unit', () => {
    it('formats sub-millisecond as "< 1ms"', () => {
      expect(formatDuration(0.0005, 's')).toBe('< 1ms');
    });
    it('formats sub-second as ms', () => {
      expect(formatDuration(0.042, 's')).toBe('42ms');
    });
    it('formats seconds', () => {
      expect(formatDuration(1.5, 's')).toBe('1.5s');
    });
  });

  describe('edge cases', () => {
    it('handles NaN gracefully', () => {
      // NaN should not crash — the output is implementation-defined
      const result = formatDuration(NaN, 'ms');
      expect(typeof result).toBe('string');
    });
    it('handles Infinity', () => {
      const result = formatDuration(Infinity, 'ms');
      expect(typeof result).toBe('string');
    });
    it('handles negative values', () => {
      const result = formatDuration(-5, 'ms');
      expect(typeof result).toBe('string');
    });
    it('handles zero exactly', () => {
      expect(formatDuration(0, 'ms')).toBe('< 1ms');
      expect(formatDuration(0, 's')).toBe('< 1ms');
    });
    it('handles boundary at 1ms exactly', () => {
      expect(formatDuration(1, 'ms')).toBe('1ms');
    });
    it('handles boundary at 1000ms exactly', () => {
      expect(formatDuration(1000, 'ms')).toBe('1.0s');
    });
  });
});
