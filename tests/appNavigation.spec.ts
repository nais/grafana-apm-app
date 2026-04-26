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

    // Plugin nav links — Grafana renders these in different locations and structures across versions
    // (sidebar links, tabs, breadcrumbs, or page header)
    await expectAnyVisible(
      [
        page.getByRole('link', { name: /Services/i }).first(),
        page.getByRole('tab', { name: /Services/i }).first(),
        page.locator('[aria-label*="Services"], [data-testid*="services"]').first(),
      ],
      { message: 'Services navigation element not found in any expected location' }
    );
    await expectAnyVisible(
      [
        page.getByRole('link', { name: /Dependencies/i }).first(),
        page.getByRole('tab', { name: /Dependencies/i }).first(),
        page.locator('[aria-label*="Dependencies"], [data-testid*="dependencies"]').first(),
      ],
      { message: 'Dependencies navigation element not found in any expected location' }
    );
  });
});
