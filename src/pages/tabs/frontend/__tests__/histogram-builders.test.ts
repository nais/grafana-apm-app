import {
  histogramFilter,
  histogramVitalTrend,
  histogramVitalInstant,
  cwvRatingExprs,
  navTypeRateExpr,
  pageLoadsRateExpr,
  errorsRateExpr,
  browserVolumeExpr,
} from '../queries/histogram-builders';

describe('histogram-builders', () => {
  describe('histogramFilter', () => {
    it('builds filter with app_name and job', () => {
      const result = histogramFilter('my-app');
      expect(result).toContain('app_name="my-app"');
      expect(result).toContain('job=');
    });

    it('includes environment when provided', () => {
      const result = histogramFilter('my-app', 'prod');
      expect(result).toContain('env="prod"');
    });

    it('omits environment when not provided', () => {
      const result = histogramFilter('my-app');
      expect(result).not.toContain('env=');
    });
  });

  describe('histogramVitalTrend', () => {
    it('returns p75 histogram_quantile query', () => {
      const filter = histogramFilter('my-app');
      const result = histogramVitalTrend('lcp', filter);
      expect(result).toContain('histogram_quantile(0.75');
      expect(result).toContain('rate(');
      expect(result).toContain('_bucket{');
      expect(result).toContain('$__rate_interval');
      expect(result).toContain('by (le)');
    });

    it('uses the correct metric for each vital', () => {
      const filter = histogramFilter('my-app');
      const lcp = histogramVitalTrend('lcp', filter);
      const fcp = histogramVitalTrend('fcp', filter);
      expect(lcp).toContain('lcp');
      expect(fcp).toContain('fcp');
      expect(lcp).not.toBe(fcp);
    });
  });

  describe('histogramVitalInstant', () => {
    it('uses increase over a fixed window', () => {
      const filter = histogramFilter('my-app');
      const result = histogramVitalInstant('lcp', filter);
      expect(result).toContain('increase(');
      expect(result).toContain('[6h]');
    });

    it('accepts custom window', () => {
      const filter = histogramFilter('my-app');
      const result = histogramVitalInstant('lcp', filter, '24h');
      expect(result).toContain('[24h]');
    });
  });

  describe('cwvRatingExprs', () => {
    it('returns good/ni/poor expressions', () => {
      const filter = histogramFilter('my-app');
      const { good, ni, poor } = cwvRatingExprs('lcp', filter);
      expect(good).toBeTruthy();
      expect(ni).toBeTruthy();
      expect(poor).toBeTruthy();
    });

    it('uses correct bucket boundaries for LCP', () => {
      const filter = histogramFilter('my-app');
      const { good, ni, poor } = cwvRatingExprs('lcp', filter);
      expect(good).toContain('le="2500"');
      expect(ni).toContain('le="4000"');
      expect(ni).toContain('le="2500"');
      expect(poor).toContain('le="4000"');
    });

    it('uses correct bucket boundaries for CLS', () => {
      const filter = histogramFilter('my-app');
      const { good, ni, poor } = cwvRatingExprs('cls', filter);
      expect(good).toContain('le="0.1"');
      expect(ni).toContain('le="0.25"');
      expect(poor).toContain('le="0.25"');
    });

    it('good expr divides good bucket by total', () => {
      const filter = histogramFilter('my-app');
      const { good } = cwvRatingExprs('lcp', filter);
      expect(good).toContain('le="+Inf"');
      expect(good).toContain('$__range');
    });

    it('poor expr computes 1 minus poor ratio', () => {
      const filter = histogramFilter('my-app');
      const { poor } = cwvRatingExprs('lcp', filter);
      expect(poor).toMatch(/^1 -/);
    });
  });

  describe('navTypeRateExpr', () => {
    it('groups by nav_type label', () => {
      const filter = histogramFilter('my-app');
      const result = navTypeRateExpr(filter);
      expect(result).toContain('sum by (nav_type)');
      expect(result).toContain('rate(');
    });
  });

  describe('pageLoadsRateExpr', () => {
    it('sums page load rate', () => {
      const filter = histogramFilter('my-app');
      const result = pageLoadsRateExpr(filter);
      expect(result).toContain('sum(rate(');
      expect(result).toContain('$__rate_interval');
    });
  });

  describe('errorsRateExpr', () => {
    it('sums error rate', () => {
      const filter = histogramFilter('my-app');
      const result = errorsRateExpr(filter);
      expect(result).toContain('sum(rate(');
      expect(result).toContain('errors');
    });
  });

  describe('browserVolumeExpr', () => {
    it('groups by browser_name with increase', () => {
      const filter = histogramFilter('my-app');
      const result = browserVolumeExpr(filter);
      expect(result).toContain('sum by (browser_name)');
      expect(result).toContain('increase(');
      expect(result).toContain('$__range');
      expect(result).toContain('browser_name!=""');
    });
  });
});
