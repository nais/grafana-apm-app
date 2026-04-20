import { test, expect } from './fixtures';

// Grafana 13+ shows a "What's new" modal on first load — dismiss it if present
async function dismissWhatsNewModal(page: import('@playwright/test').Page) {
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    const closeBtn = dialog.getByRole('button', { name: /close/i });
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeBtn.click();
      await dialog.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
    }
  }
}

// Wait for plugin config page to fully render
async function waitForConfigPage(page: import('@playwright/test').Page) {
  await dismissWhatsNewModal(page);
  // Wait for network to settle — plugin config may lazy-load
  await page.waitForLoadState('networkidle');
}

test.describe('app configuration', () => {
  test('config page should render with datasource fields', async ({ appConfigPage, page }) => {
    await waitForConfigPage(page);
    await expect(page.getByText('Data Sources')).toBeVisible();
  });

  test('should display auto-detect capability button', async ({ appConfigPage, page }) => {
    await waitForConfigPage(page);
    // Debug: log all buttons on page if the expected button is missing
    const btn = page.getByRole('button', { name: /Auto-detect/i });
    if (!(await btn.isVisible({ timeout: 5000 }).catch(() => false))) {
      const allButtons = await page.getByRole('button').all();
      const names: string[] = [];
      for (const b of allButtons) {
        names.push((await b.textContent()) || '(empty)');
      }
      console.log(`[DEBUG] Page URL: ${page.url()}`);
      console.log(`[DEBUG] Found ${allButtons.length} buttons: ${JSON.stringify(names)}`);
      console.log(`[DEBUG] Has "Data Sources": ${await page.getByText('Data Sources').count()}`);
      console.log(`[DEBUG] Has "Detection": ${await page.getByText('Detection').count()}`);
    }
    await expect(btn).toBeVisible({ timeout: 10000 });
  });
});
