import { VITAL_THRESHOLDS, VITAL_DEFS, CWV_BUCKET_BOUNDARIES, BROWSER_FILTER, VitalKey } from '../constants';

describe('constants', () => {
  describe('VITAL_THRESHOLDS', () => {
    it('has entries for all five vitals', () => {
      const keys: VitalKey[] = ['lcp', 'fcp', 'cls', 'inp', 'ttfb'];
      keys.forEach((key) => {
        expect(VITAL_THRESHOLDS[key]).toBeDefined();
        expect(VITAL_THRESHOLDS[key]).toHaveLength(3);
      });
    });

    it('has ascending threshold values', () => {
      Object.values(VITAL_THRESHOLDS).forEach((steps) => {
        for (let i = 1; i < steps.length; i++) {
          expect(steps[i].value).toBeGreaterThan(steps[i - 1].value);
        }
      });
    });

    it('uses green/orange/red color scheme', () => {
      Object.values(VITAL_THRESHOLDS).forEach((steps) => {
        expect(steps[0].color).toBe('green');
        expect(steps[1].color).toBe('orange');
        expect(steps[2].color).toBe('red');
      });
    });
  });

  describe('CWV_BUCKET_BOUNDARIES', () => {
    it('has entries for all five vitals', () => {
      const keys: VitalKey[] = ['lcp', 'fcp', 'cls', 'inp', 'ttfb'];
      keys.forEach((key) => {
        expect(CWV_BUCKET_BOUNDARIES[key]).toBeDefined();
        expect(CWV_BUCKET_BOUNDARIES[key].good).toBeDefined();
        expect(CWV_BUCKET_BOUNDARIES[key].poor).toBeDefined();
      });
    });

    it('has poor boundary > good boundary for each vital', () => {
      Object.values(CWV_BUCKET_BOUNDARIES).forEach(({ good, poor }) => {
        expect(parseFloat(poor)).toBeGreaterThan(parseFloat(good));
      });
    });

    it('aligns with VITAL_THRESHOLDS good/poor values', () => {
      expect(CWV_BUCKET_BOUNDARIES.lcp.good).toBe('2500');
      expect(CWV_BUCKET_BOUNDARIES.lcp.poor).toBe('4000');
      expect(CWV_BUCKET_BOUNDARIES.fcp.good).toBe('1800');
      expect(CWV_BUCKET_BOUNDARIES.fcp.poor).toBe('3000');
      expect(CWV_BUCKET_BOUNDARIES.cls.good).toBe('0.1');
      expect(CWV_BUCKET_BOUNDARIES.cls.poor).toBe('0.25');
      expect(CWV_BUCKET_BOUNDARIES.inp.good).toBe('200');
      expect(CWV_BUCKET_BOUNDARIES.inp.poor).toBe('500');
    });
  });

  describe('VITAL_DEFS', () => {
    it('has five definitions in page loading order', () => {
      expect(VITAL_DEFS).toHaveLength(5);
      expect(VITAL_DEFS.map((d) => d.key)).toEqual(['ttfb', 'fcp', 'lcp', 'cls', 'inp']);
    });

    it('each definition has required fields', () => {
      VITAL_DEFS.forEach((def) => {
        expect(def.label).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.tooltip).toBeTruthy();
        expect(def.thresholds).toHaveLength(3);
      });
    });

    it('CLS has no unit and has decimals', () => {
      const cls = VITAL_DEFS.find((d) => d.key === 'cls')!;
      expect(cls.unit).toBeUndefined();
      expect(cls.decimals).toBe(2);
    });

    it('timing vitals have ms unit', () => {
      const timingVitals = VITAL_DEFS.filter((d) => d.key !== 'cls');
      timingVitals.forEach((def) => {
        expect(def.unit).toBe('ms');
      });
    });
  });

  describe('BROWSER_FILTER', () => {
    it('matches $browser variable with empty-string fallback', () => {
      expect(BROWSER_FILTER).toContain('$browser');
      expect(BROWSER_FILTER).toContain('|"');
    });
  });
});
