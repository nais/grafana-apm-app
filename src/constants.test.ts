import { PLUGIN_BASE_URL, ROUTES } from './constants';

describe('constants', () => {
  it('has a valid plugin base URL', () => {
    expect(PLUGIN_BASE_URL).toMatch(/^\/a\//);
  });

  it('has all expected routes', () => {
    expect(ROUTES.Services).toBe('services');
    expect(ROUTES.ServiceOverview).toContain(':namespace');
    expect(ROUTES.ServiceOverview).toContain(':service');
    expect(ROUTES.Dependencies).toBe('dependencies');
    expect(ROUTES.DependencyDetail).toContain(':name');
  });
});
