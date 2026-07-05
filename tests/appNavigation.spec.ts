import { test, expect, PLUGIN_ROOT, expectAnyVisible } from './fixtures';
import { ROUTES } from '../src/constants';

test.describe('smoke: app navigation', () => {
  test('plugin root URL redirects to services', async ({ gotoPage, page }) => {
    await gotoPage('/');
    await expect(page).toHaveURL(/\/services/, { timeout: 10_000 });
  });

  test('services page loads with plugin content', async ({ gotoPage, page }) => {
    await gotoPage(`/${ROUTES.Services}`);
    await expect(page).toHaveURL(/\/services/);

    // Proves plugin code executed — not just a Grafana shell
    await expectAnyVisible([page.getByRole('alert'), page.locator('table')], {
      message: 'Services page did not render any plugin content',
    });
  });

  test('dependencies page loads with plugin content', async ({ gotoPage, page }) => {
    await gotoPage(`/${ROUTES.Dependencies}`);

    // In CI without datasources, page may show loading, error, empty-state, or the description text
    await expectAnyVisible(
      [
        page.getByRole('alert'),
        page.locator('table'),
        page.getByText('External dependencies detected'),
        page.getByText('Loading dependencies'),
      ],
      {
        message: 'Dependencies page did not render any plugin content',
      }
    );
  });

  test('jobs page loads with plugin content', async ({ gotoPage, page }) => {
    await gotoPage(`/${ROUTES.Jobs}`);
    await expect(page).toHaveURL(/\/jobs/);

    // Without kube-state-metrics the page shows the capability empty-state;
    // with data it renders the toolbar/table.
    await expectAnyVisible(
      [
        page.getByText('Job metrics not available'),
        page.getByPlaceholder('Filter jobs...'),
        page.locator('table'),
        page.getByRole('alert'),
      ],
      { message: 'Jobs page did not render any plugin content' }
    );
  });

  test('service map page loads with plugin content', async ({ gotoPage, page }) => {
    await gotoPage(`/${ROUTES.ServiceMap}`);
    await expect(page).toHaveURL(/\/service-map/);

    await expectAnyVisible(
      [
        page.getByText('Namespaces', { exact: true }),
        page.getByText(/Global service topology grouped by team/i),
        page.getByText('No topology data'),
        page.getByRole('alert'),
      ],
      { message: 'Service Map page did not render any plugin content' }
    );
  });

  test('sidebar navigation links are present', async ({ gotoPage, page }) => {
    await gotoPage(`/${ROUTES.Services}`);

    // Plugin nav structure varies across Grafana versions:
    // - Expanded sidebar with visible links (older versions)
    // - Collapsed sidebar section with "Expand section" button (Grafana 12+)
    // - Page heading shows plugin name
    // We verify the plugin is registered in Grafana's nav
    const pluginNav = page
      .getByRole('link', { name: /Services/i })
      .or(page.getByRole('tab', { name: /Services/i }))
      .or(page.getByRole('button', { name: /Expand section.*Nais APM/i }))
      .or(page.getByRole('heading', { name: /Nais APM/i }));
    await expect(pluginNav.first()).toBeVisible({ timeout: 15_000 });
  });

  test('Jobs and Service Map nav entries are reachable', async ({ gotoPage, page }) => {
    // Both are registered as plugin pages (plugin.json includes, addToNav:true).
    // Depending on Grafana version they surface as sidebar links, nav tabs, or
    // behind an "Expand section" toggle — assert each is reachable in some form.
    await gotoPage(`/${ROUTES.Services}`);

    const jobsNav = page
      .getByRole('link', { name: /Jobs/i })
      .or(page.getByRole('tab', { name: /Jobs/i }))
      .or(page.getByRole('button', { name: /Expand section.*Nais APM/i }))
      .or(page.getByRole('heading', { name: /Nais APM/i }));
    await expect(jobsNav.first()).toBeVisible({ timeout: 15_000 });

    const serviceMapNav = page
      .getByRole('link', { name: /Service Map/i })
      .or(page.getByRole('tab', { name: /Service Map/i }))
      .or(page.getByRole('button', { name: /Expand section.*Nais APM/i }))
      .or(page.getByRole('heading', { name: /Nais APM/i }));
    await expect(serviceMapNav.first()).toBeVisible({ timeout: 15_000 });
  });
});
