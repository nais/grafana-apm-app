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
    // Verify page title text is rendered somewhere in the page chrome or content
    await expect(page.getByText('Services').first()).toBeVisible({ timeout: 10_000 });
  });
});
