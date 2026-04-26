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
});
