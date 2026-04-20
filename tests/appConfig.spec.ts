import { test, expect } from './fixtures';

// Grafana 13+ shows a "What's new" carousel/overlay on first load.
// This makes plugin content inert (invisible to accessibility tree).
// Dismiss it by closing any dialog or clicking the carousel Close button.
async function dismissWhatsNew(page: import('@playwright/test').Page) {
  // Approach 1: Try closing a modal dialog (Grafana 13.0.x)
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    const closeBtn = dialog.getByRole('button', { name: /close/i });
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeBtn.click();
      await dialog.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
      return;
    }
  }

  // Approach 2: Close the "What's new" carousel overlay
  // In Grafana 13, this renders as an inline carousel with a Close button
  // that marks the main content as inert/aria-hidden
  const closeBtn = page.getByRole('button', { name: 'Close', exact: true });
  if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await closeBtn.click();
    // Wait for the carousel to disappear
    await closeBtn.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
  }
}

test.describe('app configuration', () => {
  test('config page should render with datasource fields', async ({ appConfigPage, page }) => {
    await dismissWhatsNew(page);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Data Sources')).toBeVisible();
  });

  test('should display auto-detect capability button', async ({ appConfigPage, page }) => {
    await dismissWhatsNew(page);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name: /Auto-detect/i })).toBeVisible({ timeout: 10000 });
  });
});
