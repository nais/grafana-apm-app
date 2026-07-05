import { computeDelta } from './healthDelta';

describe('computeDelta', () => {
  describe('lowerIsBetter polarity (error rate, P95 latency)', () => {
    it('marks a >20% relative increase as bad (red)', () => {
      const result = computeDelta(13, 10, 'lowerIsBetter'); // +30%
      expect(result.direction).toBe('increase');
      expect(result.pct).toBeCloseTo(0.3);
      expect(result.severity).toBe('bad');
    });

    it('treats exactly the 20% boundary as warn, not bad (threshold is strictly-greater-than)', () => {
      const result = computeDelta(12, 10, 'lowerIsBetter'); // +20% exactly
      expect(result.severity).toBe('warn');
    });

    it('marks a large relative increase (e.g. +190%) as bad (red)', () => {
      const result = computeDelta(0.3, 0.1, 'lowerIsBetter');
      expect(result.direction).toBe('increase');
      expect(result.severity).toBe('bad');
    });

    it('marks a >5% but <=20% relative increase as warn (orange)', () => {
      const result = computeDelta(10.8, 10, 'lowerIsBetter'); // +8%
      expect(result.direction).toBe('increase');
      expect(result.severity).toBe('warn');
    });

    it('marks a small relative increase (<=5%) as neutral', () => {
      const result = computeDelta(10.3, 10, 'lowerIsBetter'); // +3%
      expect(result.direction).toBe('increase');
      expect(result.severity).toBe('neutral');
    });

    it('marks any decrease as good, regardless of magnitude', () => {
      const tiny = computeDelta(9.9, 10, 'lowerIsBetter');
      const large = computeDelta(1, 10, 'lowerIsBetter');
      expect(tiny.direction).toBe('decrease');
      expect(tiny.severity).toBe('good');
      expect(large.direction).toBe('decrease');
      expect(large.severity).toBe('good');
    });

    it('treats a negligible change as flat/neutral', () => {
      const result = computeDelta(10.001, 10, 'lowerIsBetter');
      expect(result.direction).toBe('flat');
      expect(result.severity).toBe('neutral');
    });

    it('treats going from zero to a positive value as bad with no percentage', () => {
      const result = computeDelta(5, 0, 'lowerIsBetter');
      expect(result.pct).toBeNull();
      expect(result.direction).toBe('increase');
      expect(result.severity).toBe('bad');
    });

    it('treats zero-to-zero as flat/neutral', () => {
      const result = computeDelta(0, 0, 'lowerIsBetter');
      expect(result.pct).toBe(0);
      expect(result.direction).toBe('flat');
      expect(result.severity).toBe('neutral');
    });
  });

  describe('neutral polarity (request rate)', () => {
    it('never judges an increase as bad or good', () => {
      const result = computeDelta(1000, 10, 'neutral');
      expect(result.direction).toBe('increase');
      expect(result.severity).toBe('neutral');
    });

    it('never judges a decrease as bad or good', () => {
      const result = computeDelta(1, 100, 'neutral');
      expect(result.direction).toBe('decrease');
      expect(result.severity).toBe('neutral');
    });

    it('still reports the percentage for display', () => {
      const result = computeDelta(120, 100, 'neutral');
      expect(result.pct).toBeCloseTo(0.2);
    });
  });

  describe('missing baseline', () => {
    it('returns a null/neutral result when previous is undefined', () => {
      const result = computeDelta(42, undefined, 'lowerIsBetter');
      expect(result.pct).toBeNull();
      expect(result.direction).toBe('flat');
      expect(result.severity).toBe('neutral');
    });

    it('returns a null/neutral result when previous is null', () => {
      const result = computeDelta(42, null, 'lowerIsBetter');
      expect(result.pct).toBeNull();
      expect(result.severity).toBe('neutral');
    });

    it('returns a null/neutral result when previous is NaN', () => {
      const result = computeDelta(42, NaN, 'lowerIsBetter');
      expect(result.pct).toBeNull();
      expect(result.severity).toBe('neutral');
    });
  });
});
