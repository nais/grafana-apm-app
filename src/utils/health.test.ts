import {
  getServiceHealth,
  getDependencyHealth,
  healthSeverity,
  healthLabel,
  deltaArrow,
  SERVICE_THRESHOLDS,
  DEPENDENCY_THRESHOLDS,
} from './health';

describe('getServiceHealth', () => {
  it('returns critical when error rate exceeds critical threshold', () => {
    expect(getServiceHealth(5.1, 100, 'ms')).toBe('critical');
    expect(getServiceHealth(50, 0, 'ms')).toBe('critical');
  });

  it('returns warning when error rate exceeds warning threshold', () => {
    expect(getServiceHealth(1.5, 100, 'ms')).toBe('warning');
    expect(getServiceHealth(4.9, 100, 'ms')).toBe('warning');
  });

  it('returns warning when P95 exceeds latency threshold (ms unit)', () => {
    expect(getServiceHealth(0, 5001, 'ms')).toBe('warning');
    expect(getServiceHealth(0, 10000, 'ms')).toBe('warning');
  });

  it('returns warning when P95 exceeds latency threshold (s unit)', () => {
    expect(getServiceHealth(0, 5.1, 's')).toBe('warning');
    expect(getServiceHealth(0, 10, 's')).toBe('warning');
  });

  it('returns healthy when within all thresholds', () => {
    expect(getServiceHealth(0, 100, 'ms')).toBe('healthy');
    expect(getServiceHealth(0.5, 500, 'ms')).toBe('healthy');
    expect(getServiceHealth(1.0, 4999, 'ms')).toBe('healthy');
  });

  it('handles exact boundary values', () => {
    expect(getServiceHealth(SERVICE_THRESHOLDS.errorCritical, 0, 'ms')).toBe('warning');
    expect(getServiceHealth(SERVICE_THRESHOLDS.errorWarning, 0, 'ms')).toBe('healthy');
    expect(getServiceHealth(0, SERVICE_THRESHOLDS.p95WarningMs, 'ms')).toBe('healthy');
  });

  it('error rate takes precedence over latency', () => {
    expect(getServiceHealth(6, 100, 'ms')).toBe('critical');
    expect(getServiceHealth(2, 100, 'ms')).toBe('warning');
  });
});

describe('getDependencyHealth', () => {
  it('returns critical for error rate > 5%', () => {
    expect(getDependencyHealth(6)).toBe('critical');
    expect(getDependencyHealth(100)).toBe('critical');
  });

  it('returns warning for error rate > 1%', () => {
    expect(getDependencyHealth(2)).toBe('warning');
    expect(getDependencyHealth(5)).toBe('warning');
  });

  it('returns healthy for low error rate', () => {
    expect(getDependencyHealth(0)).toBe('healthy');
    expect(getDependencyHealth(0.5)).toBe('healthy');
    expect(getDependencyHealth(DEPENDENCY_THRESHOLDS.errorWarning)).toBe('healthy');
  });
});

describe('healthSeverity', () => {
  it('ranks critical > warning > healthy', () => {
    expect(healthSeverity('critical')).toBeGreaterThan(healthSeverity('warning'));
    expect(healthSeverity('warning')).toBeGreaterThan(healthSeverity('healthy'));
  });
});

describe('healthLabel', () => {
  it('maps to correct labels', () => {
    expect(healthLabel('critical')).toBe('Critical');
    expect(healthLabel('warning')).toBe('Warning');
    expect(healthLabel('healthy')).toBe('Healthy');
  });
});

describe('deltaArrow', () => {
  it('returns ↑ when current significantly exceeds previous', () => {
    expect(deltaArrow(10, 5)).toBe('↑');
    expect(deltaArrow(1.5, 1.0)).toBe('↑');
  });

  it('returns ↓ when current significantly below previous', () => {
    expect(deltaArrow(5, 10)).toBe('↓');
    expect(deltaArrow(0.5, 1.0)).toBe('↓');
  });

  it('returns → when values are similar', () => {
    expect(deltaArrow(10, 10)).toBe('→');
    expect(deltaArrow(10.1, 10)).toBe('→');
  });

  it('returns null when previous is undefined', () => {
    expect(deltaArrow(10, undefined)).toBeNull();
  });

  it('handles zero previous value', () => {
    expect(deltaArrow(0.1, 0)).toBe('↑');
    expect(deltaArrow(0, 0)).toBe('→');
  });
});
