import { test, expect, expectAnyVisible } from '../fixtures';
import { ROUTES } from '../../src/constants';

test.describe('Dependencies', () => {
  test.beforeEach(async ({ gotoPage }) => {
    await gotoPage(`/${ROUTES.Dependencies}`);
  });

  test('renders empty state or dependencies table', async ({ page }) => {
    // In CI without backends: page may show loading, error, empty-state, or description text.
    await expectAnyVisible(
      [
        page.getByRole('alert'),
        page.locator('table'),
        page.getByText('External dependencies detected'),
        page.getByText('Loading dependencies'),
      ],
      { message: 'Dependencies page did not render any meaningful content' }
    );
  });

  test('page heading is visible', async ({ page }) => {
    // Verify page title — Grafana renders plugin page names in various locations
    await expectAnyVisible(
      [
        page.getByRole('heading', { name: /Dependencies/i }).first(),
        page.getByRole('tab', { name: /Dependencies/i }).first(),
        page.getByRole('link', { name: /Dependencies/i }).first(),
        page
          .locator('[class*="page-header"], [class*="PageHeader"]')
          .filter({ hasText: /Dependencies/i })
          .first(),
      ],
      { message: 'Dependencies page heading not found in any expected location' }
    );
  });
});
