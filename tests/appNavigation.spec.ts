import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';

test.describe('navigating app', () => {
  test('service inventory page should render', async ({ gotoPage, page }) => {
    await gotoPage(`/${ROUTES.Services}`);
    await expect(page.getByTestId('data-testid Services breadcrumb')).toBeVisible();
  });

  test('service map page should render', async ({ gotoPage, page }) => {
    await gotoPage(`/${ROUTES.ServiceMap}`);
    await expect(page.getByTestId('data-testid Service Map breadcrumb')).toBeVisible();
  });

  test('dependencies page should render', async ({ gotoPage, page }) => {
    await gotoPage(`/${ROUTES.Dependencies}`);
    await expect(page.getByTestId('data-testid Dependencies breadcrumb')).toBeVisible();
  });
});
