import { MIN_SLO_SAMPLES, SloRawMetrics, computeSlo, formatSloTarget, sloSelector } from './sloData';

describe('computeSlo', () => {
  const healthy: SloRawMetrics = { errorRatio30d: 0.0002, total30d: 1_000_000, errorRatio1h: 0.0001 };

  it('computes compliance, remaining budget and burn for a 99.9% target', () => {
    const r = computeSlo(healthy, 0.999);
    expect(r.enoughData).toBe(true);
    // compliance = (1 - 0.0002) * 100
    expect(r.compliancePct).toBeCloseTo(99.98, 5);
    // consumed = 0.0002 / 0.001 = 0.2 → 80% remaining
    expect(r.budgetRemainingPct).toBeCloseTo(80, 5);
    // burn = 0.0001 / 0.001
    expect(r.burnRate1h).toBeCloseTo(0.1, 5);
    expect(r.status).toBe('healthy');
  });

  it('classifies status by remaining budget (green >50, orange >20, red below)', () => {
    // remaining 40% (consumed 0.6 of budget)
    expect(computeSlo({ errorRatio30d: 0.0006, total30d: 1e6, errorRatio1h: 0 }, 0.999).status).toBe('warning');
    // remaining 10% → critical
    expect(computeSlo({ errorRatio30d: 0.0009, total30d: 1e6, errorRatio1h: 0 }, 0.999).status).toBe('critical');
  });

  it('reports a negative remaining budget when the SLO is overspent', () => {
    // stricter target: 0.0002 error against a 0.0001 budget = 200% consumed
    const r = computeSlo(healthy, 0.9999);
    expect(r.budgetRemainingPct).toBeCloseTo(-100, 5);
    expect(r.status).toBe('critical');
  });

  it('degrades to "not enough data" below the sample floor but still reports burn', () => {
    const r = computeSlo({ errorRatio30d: 0.0002, total30d: MIN_SLO_SAMPLES - 1, errorRatio1h: 0.05 }, 0.999);
    expect(r.enoughData).toBe(false);
    expect(r.compliancePct).toBeNull();
    expect(r.budgetRemainingPct).toBeNull();
    expect(r.status).toBe('unknown');
    // burn is independent of the 30d window
    expect(r.burnRate1h).toBeCloseTo(50, 5);
  });

  it('degrades when the 30d window returned no traffic', () => {
    const r = computeSlo({ errorRatio30d: null, total30d: null, errorRatio1h: null }, 0.999);
    expect(r.enoughData).toBe(false);
    expect(r.burnRate1h).toBeNull();
  });
});

describe('sloSelector', () => {
  it('includes namespace and single environment', () => {
    expect(sloSelector('my-svc', 'team-a', 'prod-gcp')).toBe(
      'service_name="my-svc", service_namespace="team-a", k8s_cluster_name="prod-gcp"'
    );
  });

  it('omits the namespace matcher when there is no namespace', () => {
    expect(sloSelector('my-svc', '')).toBe('service_name="my-svc"');
  });

  it('uses a regex matcher for multiple environments', () => {
    expect(sloSelector('my-svc', 'team-a', 'prod-gcp,prod-fss')).toBe(
      'service_name="my-svc", service_namespace="team-a", k8s_cluster_name=~"prod-gcp|prod-fss"'
    );
  });
});

describe('formatSloTarget', () => {
  it('renders fractions as percentage labels', () => {
    expect(formatSloTarget(0.99)).toBe('99%');
    expect(formatSloTarget(0.995)).toBe('99.5%');
    expect(formatSloTarget(0.999)).toBe('99.9%');
    expect(formatSloTarget(0.9999)).toBe('99.99%');
  });
});
