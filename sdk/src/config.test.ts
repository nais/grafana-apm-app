import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetDevModeWarning, resolveConfig, versionFromImage } from './config.js';

function addMeta(name: string, content: string): void {
  const meta = document.createElement('meta');
  meta.setAttribute('name', name);
  meta.setAttribute('content', content);
  document.head.appendChild(meta);
}

describe('resolveConfig', () => {
  beforeEach(() => {
    _resetDevModeWarning();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    document.head.querySelectorAll('meta').forEach((meta) => meta.remove());
  });

  it('resolves everything from nais meta tags', () => {
    addMeta('nais-app', 'soknad-dagpenger');
    addMeta('nais-cluster', 'prod-gcp');
    addMeta('nais-version', '2026.07.03-abc1234');
    addMeta('nais-telemetry-url', 'https://telemetry.nav.no/collect');

    const config = resolveConfig();
    expect(config).toEqual({
      app: 'soknad-dagpenger',
      environment: 'prod-gcp',
      version: '2026.07.03-abc1234',
      telemetryUrl: 'https://telemetry.nav.no/collect',
      devMode: false,
    });
  });

  it('prefers explicit init options over meta tags', () => {
    addMeta('nais-app', 'meta-app');
    addMeta('nais-telemetry-url', 'https://meta.example/collect');

    const config = resolveConfig({
      app: 'explicit-app',
      telemetryUrl: 'https://explicit.example/collect',
    });
    expect(config.app).toBe('explicit-app');
    expect(config.telemetryUrl).toBe('https://explicit.example/collect');
  });

  it('falls back to build-time NAIS_* env vars', () => {
    vi.stubEnv('NAIS_APP_NAME', 'env-app');
    vi.stubEnv('NAIS_CLUSTER_NAME', 'dev-gcp');
    vi.stubEnv('NAIS_APP_IMAGE', 'europe-north1-docker.pkg.dev/nais/env-app:1.2.3-cafebabe');

    const config = resolveConfig();
    expect(config.app).toBe('env-app');
    expect(config.environment).toBe('dev-gcp');
    expect(config.version).toBe('1.2.3-cafebabe');
  });

  it('meta tags win over env vars', () => {
    vi.stubEnv('NAIS_APP_NAME', 'env-app');
    addMeta('nais-app', 'meta-app');
    expect(resolveConfig().app).toBe('meta-app');
  });

  it('prefers GITHUB_SHA over the image tag for the version (release identity, #64)', () => {
    vi.stubEnv('GITHUB_SHA', 'abc1234def5678');
    vi.stubEnv('NAIS_APP_IMAGE', 'europe-north1-docker.pkg.dev/nais/env-app:1.2.3-cafebabe');
    expect(resolveConfig({ app: 'a', environment: 'dev-gcp' }).version).toBe('abc1234def5678');
  });

  it('derives the well-known collector from the cluster name', () => {
    expect(resolveConfig({ app: 'a', environment: 'prod-gcp' }).telemetryUrl).toBe(
      'https://telemetry.nav.no/collect'
    );
    expect(resolveConfig({ app: 'a', environment: 'dev-gcp' }).telemetryUrl).toBe(
      'https://telemetry.ekstern.dev.nav.no/collect'
    );
  });

  it('enters dev mode and warns once when no collector resolves', () => {
    const first = resolveConfig();
    const second = resolveConfig();
    expect(first.devMode).toBe(true);
    expect(first.app).toBe('unknown-app');
    expect(second.devMode).toBe(true);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('dev mode');
  });

  it('ignores empty meta tag content', () => {
    addMeta('nais-app', '');
    vi.stubEnv('NAIS_APP_NAME', 'env-app');
    expect(resolveConfig().app).toBe('env-app');
  });
});

describe('versionFromImage', () => {
  it('extracts the tag', () => {
    expect(versionFromImage('ghcr.io/navikt/app:2026.07.03-abc1234')).toBe('2026.07.03-abc1234');
  });

  it('handles registry ports without a tag', () => {
    expect(versionFromImage('registry.local:5000/navikt/app')).toBeUndefined();
  });

  it('handles registry ports with a tag', () => {
    expect(versionFromImage('registry.local:5000/navikt/app:v1')).toBe('v1');
  });

  it('returns undefined for untagged or empty input', () => {
    expect(versionFromImage('ghcr.io/navikt/app')).toBeUndefined();
    expect(versionFromImage(undefined)).toBeUndefined();
  });
});
