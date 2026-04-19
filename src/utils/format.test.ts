import { formatDuration, DEP_TYPE_ICONS } from './format';

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
});

describe('DEP_TYPE_ICONS', () => {
  it('has entries for common dependency types', () => {
    expect(DEP_TYPE_ICONS.redis).toBeDefined();
    expect(DEP_TYPE_ICONS.postgresql).toBeDefined();
    expect(DEP_TYPE_ICONS.kafka).toBeDefined();
    expect(DEP_TYPE_ICONS.service).toBeDefined();
    expect(DEP_TYPE_ICONS.external).toBeDefined();
  });
});
