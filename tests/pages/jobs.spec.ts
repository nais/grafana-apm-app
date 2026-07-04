import { test, expect, expectAnyVisible } from '../fixtures';
import { ROUTES } from '../../src/constants';

test.describe('Jobs', () => {
  test.beforeEach(async ({ gotoPage }) => {
    await gotoPage(`/${ROUTES.Jobs}`);
  });

  test('renders table, empty-state, or capability notice — never blank', async ({ page }) => {
    // In CI (kube-state-metrics job families usually absent) the page shows the
    // "Job metrics not available" capability empty-state. With KSM present it
    // shows the toolbar + table (and possibly a "No jobs found" info alert).
    await expectAnyVisible(
      [
        page.getByText('Job metrics not available'),
        page.getByPlaceholder('Filter jobs...'),
        page.locator('table'),
        page.getByRole('alert'),
        page.getByText('Loading jobs'),
      ],
      { message: 'Jobs page did not render any meaningful content' }
    );
  });

  test('shows the toolbar/search when jobs data is available', async ({ page }) => {
    // The capability empty-state replaces the whole toolbar, so assert
    // conditionally: either the capability notice OR the search toolbar.
    const capabilityNotice = page.getByText('Job metrics not available');
    const searchBox = page.getByPlaceholder('Filter jobs...');

    const matched = await expectAnyVisible([capabilityNotice, searchBox], {
      message: 'Jobs page showed neither the capability notice nor the search toolbar',
    });

    // When the toolbar is present, the failing-only filter pill is too.
    if ((await searchBox.isVisible().catch(() => false)) && matched === searchBox) {
      await expect(page.getByText(/Failing/).first()).toBeVisible();
    }
  });

  test('page heading is visible', async ({ page }) => {
    const heading = page
      .getByRole('heading', { name: /Jobs/i })
      .or(page.getByRole('heading', { name: /Nais APM/i }))
      .or(page.getByRole('tab', { name: /Jobs/i }))
      .or(page.getByRole('link', { name: /Jobs/i }));
    await expect(heading.first()).toBeVisible({ timeout: 15_000 });
  });
});
