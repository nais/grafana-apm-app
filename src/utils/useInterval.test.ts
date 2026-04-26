import { REFRESH_INTERVALS } from './useInterval';

describe('useInterval', () => {
  describe('REFRESH_INTERVALS', () => {
    it('provides 30s, 1m, and 5m options', () => {
      expect(REFRESH_INTERVALS).toHaveLength(3);
      expect(REFRESH_INTERVALS[0]).toEqual({ label: '30s', value: 30000 });
      expect(REFRESH_INTERVALS[1]).toEqual({ label: '1m', value: 60000 });
      expect(REFRESH_INTERVALS[2]).toEqual({ label: '5m', value: 300000 });
    });
  });
});
