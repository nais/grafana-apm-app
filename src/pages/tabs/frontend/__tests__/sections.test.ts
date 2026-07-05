import { otel } from '../../../../otelconfig';
import { buildErrorsSection, buildBrowserBreakdownSection } from '../sections';
import type { FrontendSceneContext } from '../scene-context';

function makeCtx(overrides: Partial<FrontendSceneContext> = {}): FrontendSceneContext {
  return {
    metricsDs: { uid: 'mimir' },
    logsDs: { uid: 'loki' },
    service: 'checkout',
    namespace: 'team-a',
    environment: 'prod',
    svcFilter: 'app_name="checkout", env="prod"',
    hasLoki: true,
    ah: otel.alloyHistogram,
    ...overrides,
  };
}

// Serialize a scene subtree so we can assert on panel titles/queries the same
// way the database scene tests do.
function serialize(node: unknown): string {
  return JSON.stringify(node);
}

describe('buildErrorsSection', () => {
  it('no-Loki fallback keeps Exception Types as the sole errors surface (P5)', () => {
    const layout = buildErrorsSection(makeCtx({ hasLoki: false }));
    const s = serialize(layout.state);
    expect(s).toContain('Exception Types');
    // The compact IssuesTable is unavailable without Loki, so it must not render.
    expect(s).not.toContain('IssuesTable');
  });

  it('with Loki renders the compact issues table, not the Exception Types panel (P5)', () => {
    const layout = buildErrorsSection(makeCtx({ hasLoki: true }));
    const s = serialize(layout.state);
    expect(s).not.toContain('Exception Types');
  });
});

describe('buildBrowserBreakdownSection', () => {
  it('drops the Exception Types panel on the hasLoki path (P5)', () => {
    const layout = buildBrowserBreakdownSection(makeCtx({ hasLoki: true }));
    expect(layout).not.toBeNull();
    const s = serialize(layout!.state);
    expect(s).not.toContain('Exception Types');
    // The per-browser vitals table and traffic share still render.
    expect(s).toContain('Browser Breakdown');
    expect(s).toContain('Browser Volume');
  });

  it('returns null without Loki (fallback owns the errors surface)', () => {
    expect(buildBrowserBreakdownSection(makeCtx({ hasLoki: false }))).toBeNull();
  });

  it('no longer renders a Console Errors table anywhere (P4)', () => {
    const errors = serialize(buildErrorsSection(makeCtx({ hasLoki: true })).state);
    const browser = serialize(buildBrowserBreakdownSection(makeCtx({ hasLoki: true }))!.state);
    expect(errors).not.toContain('Console Errors');
    expect(browser).not.toContain('Console Errors');
  });
});
