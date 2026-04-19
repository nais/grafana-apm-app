import { test, expect } from './fixtures';

test.describe('app configuration', () => {
  test('config page should render with datasource fields', async ({ appConfigPage, page }) => {
    await expect(page.getByText('Data Sources')).toBeVisible();
  });

  test('should display auto-detect capability button', async ({ appConfigPage, page }) => {
    await expect(page.getByRole('button', { name: /Auto-Detect/i })).toBeVisible();
  });
});
