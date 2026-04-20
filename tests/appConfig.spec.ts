import { test, expect } from './fixtures';

// Grafana 13+ shows a "What's new" carousel/overlay on first load that makes
// plugin content inert (invisible to the accessibility tree). We must dismiss
// it before asserting on plugin elements. Uses CSS selectors with .first() to
// avoid Playwright strict-mode violations when multiple Close buttons exist.
async function dismissWhatsNew(page: import('@playwright/test').Page) {
  await page.waitForLoadState('networkidle');

  // Click any visible close button (aria-label="Close") — covers both
  // the "What's new" carousel and modal dialog variants in Grafana 13.
  const closeBtn = page.locator('button[aria-label="Close"]').first();
  try {
    await closeBtn.waitFor({ state: 'visible', timeout: 3000 });
    await closeBtn.click();
    await page.waitForTimeout(500);
  } catch {
    // No overlay present (e.g. Grafana 12) — nothing to dismiss
  }
}

test.describe('app configuration', () => {
  test('config page should render with datasource fields', async ({ appConfigPage, page }) => {
    await dismissWhatsNew(page);
    await expect(page.getByText('Data Sources')).toBeVisible();
  });

  test('should display auto-detect capability button', async ({ appConfigPage, page }) => {
    await dismissWhatsNew(page);
    await expect(page.getByRole('button', { name: /Auto-detect/i })).toBeVisible({ timeout: 10000 });
  });
});
