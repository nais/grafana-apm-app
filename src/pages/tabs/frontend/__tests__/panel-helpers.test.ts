import { normalizePageUrlExpr } from '../panel-helpers';

describe('panel-helpers', () => {
  describe('normalizePageUrlExpr', () => {
    it('wraps expression in sum by label', () => {
      const result = normalizePageUrlExpr('count_over_time({app="x"}[$__range])', 'page_url');
      expect(result).toContain('sum by (page_url)');
    });

    it('applies three label_replace operations', () => {
      const result = normalizePageUrlExpr('count_over_time({app="x"}[$__range])', 'page_url');
      const matches = result.match(/label_replace/g);
      expect(matches).toHaveLength(3);
    });

    it('strips query parameters', () => {
      const result = normalizePageUrlExpr('count_over_time({app="x"}[$__range])', 'page_url');
      // Query param stripping pattern
      expect(result).toContain('([^?]*)');
    });

    it('collapses UUIDs into wildcard', () => {
      const result = normalizePageUrlExpr('count_over_time({app="x"}[$__range])', 'page_url');
      // UUID pattern
      expect(result).toContain('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}');
    });

    it('collapses long numeric IDs into wildcard', () => {
      const result = normalizePageUrlExpr('count_over_time({app="x"}[$__range])', 'page_url');
      // Numeric ID pattern (5+ digits)
      expect(result).toContain('[0-9]{5,}');
    });

    it('uses the provided label name throughout', () => {
      const result = normalizePageUrlExpr('some_expr', 'route');
      expect(result).toContain('sum by (route)');
      expect(result).toContain('"route"');
    });
  });
});
