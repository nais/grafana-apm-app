import { test, expect, expectAnyVisible } from '../fixtures';
import { ROUTES } from '../../src/constants';

test.describe('Service Inventory', () => {
  test.beforeEach(async ({ gotoPage }) => {
    await gotoPage(`/${ROUTES.Services}`);
  });

  test('renders empty state or service table', async ({ page }) => {
    // In CI (no Mimir/Tempo/Loki): the backend returns 503 or empty data.
    // The page should show one of these states — never a blank screen.
    await expectAnyVisible(
      [
        page.getByText('No span metrics detected'),
        page.getByText('No services found'),
        page.getByRole('alert'),
        page.locator('table'),
      ],
      { message: 'ServiceInventory did not render any meaningful content' }
    );
  });

  test('page heading is visible', async ({ page }) => {
    // Verify page title — Grafana renders plugin page names in various locations
    // (heading, breadcrumb, tab, nav) depending on version
    await expectAnyVisible(
      [
        page.getByRole('heading', { name: /Services/i }).first(),
        page.getByRole('tab', { name: /Services/i }).first(),
        page.getByRole('link', { name: /Services/i }).first(),
        page
          .locator('[class*="page-header"], [class*="PageHeader"]')
          .filter({ hasText: /Services/i })
          .first(),
      ],
      { message: 'Services page heading not found in any expected location' }
    );
  });
});
