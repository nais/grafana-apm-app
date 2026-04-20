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

      // Check for iframes
      const iframeCount = await page.locator('iframe').count();
      console.log(`[DEBUG] Iframes on page: ${iframeCount}`);

      // Check "Auto-detect" text anywhere (including hidden)
      const autoDetectEls = await page.locator('text=Auto-detect').all();
      console.log(`[DEBUG] "Auto-detect" text count: ${autoDetectEls.length}`);
      for (let i = 0; i < autoDetectEls.length; i++) {
        const el = autoDetectEls[i];
        const tag = await el.evaluate((e) => e.tagName);
        const vis = await el.isVisible().catch(() => false);
        const txt = (await el.textContent()) || '(empty)';
        console.log(`[DEBUG]   [${i}] <${tag}> visible=${vis} text="${txt.slice(0, 60)}"`);
      }

      // Check if any button-like element contains "Auto-detect"
      const btnHasText = await page.locator('button:has-text("Auto-detect")').count();
      const roleHasText = await page.locator('[role="button"]:has-text("Auto-detect")').count();
      console.log(`[DEBUG] button:has-text count: ${btnHasText}, [role=button]:has-text count: ${roleHasText}`);

      // Dump the 7 buttons' outerHTML (truncated)
      for (let i = 0; i < Math.min(allButtons.length, 3); i++) {
        const html = await allButtons[i].evaluate((e) => e.outerHTML.slice(0, 200));
        console.log(`[DEBUG] button[${i}] html: ${html}`);
      }
    }
    await expect(btn).toBeVisible({ timeout: 10000 });
  });
});
