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

    await expectAnyVisible([page.getByRole('alert'), page.locator('table')], {
      message: 'Dependencies page did not render any plugin content',
    });
  });

  test('sidebar navigation links are present', async ({ gotoPage, page }) => {
    await gotoPage(`/${ROUTES.Services}`);

    // Plugin nav links appear in the sidebar — structure varies by Grafana version
    const sidebar = page.locator('[class*="sidemenu"], [aria-label*="Nav"], nav').first();
    await expect(sidebar.getByRole('link', { name: /Services/i }).first()).toBeVisible({ timeout: 10_000 });
    await expect(sidebar.getByRole('link', { name: /Dependencies/i }).first()).toBeVisible();
  });
});
