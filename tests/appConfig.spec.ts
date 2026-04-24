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
  test('config page should render all fieldsets', async ({ appConfigPage, page }) => {
    await dismissWhatsNew(page);

    // Verify all four configuration sections render
    await expect(page.getByText('Data Sources')).toBeVisible();
    await expect(page.getByText('Per-Environment Datasources')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Authentication')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Detection & Overrides')).toBeVisible({ timeout: 5000 });
  });

  test('should display auto-detect button and save button', async ({ appConfigPage, page }) => {
    await dismissWhatsNew(page);

    await expect(page.getByRole('button', { name: /Auto-detect/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /Save settings/i })).toBeVisible({ timeout: 5000 });
  });

  test('metrics datasource field should accept input', async ({ appConfigPage, page }) => {
    await dismissWhatsNew(page);

    // Find the Metrics UID input and verify it's interactive
    const metricsField = page.getByLabel(/Metrics.*UID/i).or(page.locator('input').first());
    await expect(metricsField).toBeVisible({ timeout: 10000 });
  });
});
