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
    // Grafana renders the plugin name ("Nais APM") as the page heading,
    // not the sub-page name ("Services") — varies by version
    const heading = page
      .getByRole('heading', { name: /Services/i })
      .or(page.getByRole('heading', { name: /Nais APM/i }))
      .or(page.getByRole('tab', { name: /Services/i }))
      .or(page.getByRole('link', { name: /Services/i }));
    await expect(heading.first()).toBeVisible({ timeout: 15_000 });
  });
});
