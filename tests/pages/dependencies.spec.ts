import { test, expect, expectAnyVisible } from '../fixtures';
import { ROUTES } from '../../src/constants';

test.describe('Dependencies', () => {
  test.beforeEach(async ({ gotoPage }) => {
    await gotoPage(`/${ROUTES.Dependencies}`);
  });

  test('renders empty state or dependencies table', async ({ page }) => {
    // In CI without backends: expect an empty-state alert or error.
    // With data: expect a table or search controls.
    await expectAnyVisible(
      [page.getByText('No dependencies detected'), page.getByText('Error loading dependencies'), page.locator('table')],
      { message: 'Dependencies page did not render any meaningful content' }
    );
  });

  test('page heading is visible', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /Dependencies/i }).first()).toBeVisible({ timeout: 10_000 });
  });
});
