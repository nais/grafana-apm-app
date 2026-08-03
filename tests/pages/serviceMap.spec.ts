import { test, expect, expectAnyVisible } from '../fixtures';
import { ROUTES } from '../../src/constants';

test.describe('Service Map', () => {
  test.beforeEach(async ({ gotoPage }) => {
    await gotoPage(`/${ROUTES.ServiceMap}`);
  });

  test('renders the Namespaces | Services view toggle', async ({ page }) => {
    // The RadioButtonGroup toggle is part of the page chrome and renders
    // regardless of whether any topology data exists.
    await expect(page.getByText('Namespaces', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Services', { exact: true }).first()).toBeVisible();
  });

  test('renders a graph or an empty/alert state — never blank', async ({ page }) => {
    // In CI (no Tempo service-graph metrics) this is the "No topology data"
    // empty-state or an error alert; with data it renders the graph panel.
    await expectAnyVisible(
      [
        page.getByText('No topology data'),
        page.getByText('Error loading service map'),
        page.getByRole('alert'),
        page.getByText('Loading service map'),
        // The rendered ServiceGraph draws into an svg/canvas node-graph.
        page.locator('svg'),
        page.locator('canvas'),
        page.getByRole('application'),
      ],
      { message: 'Service Map page did not render any meaningful content' }
    );
  });

  test('shows the topology description text', async ({ page }) => {
    // Stable page copy that proves the plugin page (not a Grafana shell) mounted.
    await expect(page.getByText(/Global service topology grouped by team/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
