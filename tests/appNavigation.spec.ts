import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';

test.describe('navigating app', () => {
  test('service inventory page should render with content', async ({ gotoPage, page }) => {
    await gotoPage(`/${ROUTES.Services}`);
    await expect(page).toHaveURL(/\/services/);

    // The page should render meaningful content, not just a URL.
    // Without backend data, we expect either a "No span metrics" warning,
    // a "No services found" info alert, or a loading state that resolves.
    // Any of these proves our plugin code is executing.
    const noMetrics = page.getByText('No span metrics detected');
    const noServices = page.getByText('No services found');
    const serviceTable = page.locator('table');

    await expect(noMetrics.or(noServices).or(serviceTable).first()).toBeVisible({ timeout: 15000 });
  });

  test('dependencies page should render with content', async ({ gotoPage, page }) => {
    await gotoPage(`/${ROUTES.Dependencies}`);

    // Verify the page actually loads our plugin content.
    // Without backend data, we expect "No dependencies detected" or
    // the dependencies table/search UI to appear.
    const noDeps = page.getByText('No dependencies detected');
    const depsTable = page.locator('table');
    const searchInput = page.getByPlaceholder(/search|filter/i);

    await expect(noDeps.or(depsTable).or(searchInput).first()).toBeVisible({ timeout: 15000 });
  });
});
