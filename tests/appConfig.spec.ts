import { test, expect } from './fixtures';

// Grafana 13+ shows a "What's new" modal on first load — dismiss it if present
async function dismissWhatsNewModal(page: import('@playwright/test').Page) {
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible({ timeout: 1000 }).catch(() => false)) {
    await dialog.getByRole('button', { name: 'Close' }).click();
  }
}

test.describe('app configuration', () => {
  test('config page should render with datasource fields', async ({ appConfigPage, page }) => {
    await dismissWhatsNewModal(page);
    await expect(page.getByText('Data Sources')).toBeVisible();
  });

  test('should display auto-detect capability button', async ({ appConfigPage, page }) => {
    await dismissWhatsNewModal(page);
    await expect(page.getByRole('button', { name: /Auto-detect/i })).toBeVisible();
  });
});
