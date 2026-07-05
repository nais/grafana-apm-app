import { test, expect, expectAnyVisible } from '../fixtures';

// A plausible namespace. In CI (no Mimir/Tempo/Loki) it has no data, but the
// namespace overview derives its header from the URL param and must still show
// a resilient state (header + empty/alert), never a blank screen.
const NAMESPACE = 'myteam';

test.describe('Namespace Overview', () => {
  test.beforeEach(async ({ gotoPage }) => {
    await gotoPage(`/namespaces/${NAMESPACE}`);
  });

  test('renders a meaningful state', async ({ page }) => {
    await expectAnyVisible(
      [
        page.getByText(NAMESPACE).first(),
        page.getByRole('alert'),
        page.locator('table'),
        page.getByText(/No services|No span metrics|not available/i).first(),
      ],
      { message: 'Namespace Overview did not render meaningful content' }
    );
  });
});
