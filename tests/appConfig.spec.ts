import { test, expect } from './fixtures';

test.describe('smoke: app configuration', () => {
  test('config page loads with plugin content', async ({ appConfigPage, page }) => {
    // Proves the AppConfig React component rendered — not just Grafana chrome
    await expect(page.getByText('Data Sources')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Save settings/i })).toBeVisible();
  });
});
