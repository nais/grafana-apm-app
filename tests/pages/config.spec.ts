import { test, expect } from '../fixtures';

test.describe('Configuration', () => {
  test('renders all configuration sections', async ({ appConfigPage, page }) => {
    await expect(page.getByText('Data Sources')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Per-Environment Datasources')).toBeVisible();
    await expect(page.getByText('Authentication')).toBeVisible();
    await expect(page.getByText('Detection & Overrides')).toBeVisible();
  });

  test('datasource fields are present', async ({ appConfigPage, page }) => {
    await expect(page.getByText('Metrics (Prometheus/Mimir)')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Traces (Tempo)')).toBeVisible();
    await expect(page.getByText('Logs (Loki)')).toBeVisible();
  });

  test('auto-detect and save buttons are actionable', async ({ appConfigPage, page }) => {
    const autoDetect = page.getByRole('button', { name: /Auto-detect/i });
    const save = page.getByRole('button', { name: /Save settings/i });

    await expect(autoDetect).toBeVisible({ timeout: 10_000 });
    await expect(autoDetect).toBeEnabled();
    await expect(save).toBeVisible();
    await expect(save).toBeEnabled();
  });

  test('save settings persists without error', async ({ appConfigPage, page }) => {
    const save = page.getByRole('button', { name: /Save settings/i });
    await expect(save).toBeVisible({ timeout: 10_000 });
    await save.click();

    // After save, verify no error toast appears
    await page.waitForTimeout(2000);
    const errorToast = page.locator('[data-testid="data-testid Alert error"]');
    await expect(errorToast).toBeHidden({ timeout: 3000 });
  });

  test('authentication section has service account token field', async ({ appConfigPage, page }) => {
    await expect(page.getByText('Grafana Service Account Token')).toBeVisible({ timeout: 10_000 });
  });

  test('detection overrides has namespace and duration fields', async ({ appConfigPage, page }) => {
    await expect(page.getByText('Metric Namespace')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Duration Unit')).toBeVisible();
  });
});
