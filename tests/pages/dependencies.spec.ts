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
    // Grafana renders the plugin name ("Nais APM") as the page heading,
    // not the sub-page name ("Dependencies") — varies by version
    const heading = page
      .getByRole('heading', { name: /Dependencies/i })
      .or(page.getByRole('heading', { name: /Nais APM/i }))
      .or(page.getByRole('tab', { name: /Dependencies/i }))
      .or(page.getByRole('link', { name: /Dependencies/i }));
    await expect(heading.first()).toBeVisible({ timeout: 15_000 });
  });
});
