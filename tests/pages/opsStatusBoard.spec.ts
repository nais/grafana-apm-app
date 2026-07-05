import { test, expect, expectAnyVisible } from '../fixtures';
import { ROUTES } from '../../src/constants';

// The Ops Status Board is a fleet wallboard with no data dependency to render
// its shell — the "Add services" picker is available even with zero services
// monitored, so this is testable in CI without any datasource.
test.describe('Ops Status Board', () => {
  test.beforeEach(async ({ gotoPage }) => {
    await gotoPage(`/${ROUTES.OpsStatus}`);
  });

  test('renders the board shell', async ({ page }) => {
    await expectAnyVisible(
      [
        page.getByText('Ops Status Board'),
        page.getByRole('button', { name: /Add services/i }),
        page.getByText(/services monitored/i),
      ],
      { message: 'Ops Status Board did not render its shell' }
    );
  });

  test('the add-services picker modal opens', async ({ page }) => {
    // Guards the OpsServicePicker (modal sizing + per-environment watchlist
    // scoping). The modal opens regardless of whether any services exist.
    await page
      .getByRole('button', { name: /Add services/i })
      .first()
      .click();
    await expect(page.getByText('Configure services')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder('Search namespace or service')).toBeVisible();
  });
});
