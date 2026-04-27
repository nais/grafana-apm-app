import {
  lokiVitalPipeline,
  lokiVitalExpr,
  lokiVitalByGroupExpr,
  lokiVitalByPageExpr,
  lokiExceptionExpr,
  lokiTopExceptionsExpr,
  lokiExceptionSessionsExpr,
  lokiSessionStartExpr,
  lokiConsoleErrorsExpr,
  lokiMeasurementCountExpr,
  lokiRatingExpr,
} from '../queries/loki-builders';

describe('loki-builders', () => {
  const service = 'my-app';

  describe('lokiVitalPipeline', () => {
    it('builds a stream selector with service and measurement kind', () => {
      const result = lokiVitalPipeline(service, 'lcp');
      expect(result).toContain(`service_name="my-app"`);
      expect(result).toContain('kind="measurement"');
      expect(result).toContain('logfmt');
      expect(result).toContain('lcp!=""');
      expect(result).toContain('keep lcp');
    });

    it('applies browser filter by default', () => {
      const result = lokiVitalPipeline(service, 'lcp');
      expect(result).toContain('browser_name=~"$browser|"');
    });

    it('includes extra keep fields when provided', () => {
      const result = lokiVitalPipeline(service, 'lcp', 'page_url');
      expect(result).toContain('keep lcp, page_url');
    });

    it('accepts custom browser filter', () => {
      const result = lokiVitalPipeline(service, 'lcp', undefined, '| browser_name="Chrome"');
      expect(result).toContain('browser_name="Chrome"');
      expect(result).not.toContain('$browser');
    });

    it('sanitizes service names with special characters', () => {
      const result = lokiVitalPipeline('my"app', 'lcp');
      expect(result).not.toContain('"my"app"');
    });
  });

  describe('lokiVitalExpr', () => {
    it('returns weighted mean formula', () => {
      const result = lokiVitalExpr(service, 'lcp', '[$__range]');
      expect(result).toContain('sum_over_time');
      expect(result).toContain('count_over_time');
      expect(result).toContain('unwrap lcp');
      expect(result).toContain('[$__range]');
    });
  });

  describe('lokiVitalByGroupExpr', () => {
    it('groups by the specified label', () => {
      const result = lokiVitalByGroupExpr(service, 'lcp', 'browser_name', '[$__range]');
      expect(result).toContain('sum by (browser_name)');
      expect(result).toContain('keep lcp, browser_name');
    });
  });

  describe('lokiVitalByPageExpr', () => {
    it('returns raw per-page average without URL normalization', () => {
      const result = lokiVitalByPageExpr(service, 'lcp', 'page_url', '[$__range]');
      expect(result).toContain('page_url');
      expect(result).toContain('sum by (page_url)');
      expect(result).toContain('unwrap lcp');
      expect(result).not.toContain('label_replace');
    });
  });

  describe('lokiExceptionExpr', () => {
    it('counts exception log lines', () => {
      const result = lokiExceptionExpr(service, '[$__range]');
      expect(result).toContain('kind="exception"');
      expect(result).toContain('count_over_time');
    });
  });

  describe('lokiTopExceptionsExpr', () => {
    it('uses topk to rank exceptions by value', () => {
      const result = lokiTopExceptionsExpr(service, '[$__range]');
      expect(result).toContain('topk(20');
      expect(result).toContain('sum by (value)');
      expect(result).toContain('value!=""');
    });
  });

  describe('lokiExceptionSessionsExpr', () => {
    it('counts unique sessions per exception', () => {
      const result = lokiExceptionSessionsExpr(service, '[$__range]');
      expect(result).toContain('count by (value)');
      expect(result).toContain('keep value, session_id');
      expect(result).toContain('session_id!=""');
    });
  });

  describe('lokiSessionStartExpr', () => {
    it('filters for session_start events', () => {
      const result = lokiSessionStartExpr(service, '[$__range]');
      expect(result).toContain('event_name="session_start"');
      expect(result).toContain('kind="event"');
    });
  });

  describe('lokiConsoleErrorsExpr', () => {
    it('filters for error-level logs', () => {
      const result = lokiConsoleErrorsExpr(service, '[$__range]');
      expect(result).toContain('level="error"');
      expect(result).toContain('kind="log"');
      expect(result).toContain('topk(10');
    });
  });

  describe('lokiMeasurementCountExpr', () => {
    it('counts web-vitals measurements', () => {
      const result = lokiMeasurementCountExpr(service, '[$__range]');
      expect(result).toContain('type="web-vitals"');
      expect(result).toContain('count_over_time');
    });
  });

  describe('lokiRatingExpr', () => {
    it('groups by rating label', () => {
      const result = lokiRatingExpr(service, '[$__range]');
      expect(result).toContain('sum by (context_rating)');
      expect(result).toContain('context_rating!=""');
    });
  });
});
