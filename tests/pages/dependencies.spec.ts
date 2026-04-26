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
    // Verify page title text is rendered somewhere in the page chrome or content
    await expect(page.getByText('Dependencies').first()).toBeVisible({ timeout: 10_000 });
  });
});
