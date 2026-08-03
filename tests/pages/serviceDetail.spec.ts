import { test, expect, expectAnyVisible } from '../fixtures';
import type { Locator, Page } from '@playwright/test';

// A plausible namespace/service. In CI (no Mimir/Tempo/Loki) no real data
// exists for it, but the detail page derives its header + tab bar from the URL
// params alone, so it must still render a resilient, non-blank state.
const NAMESPACE = 'myteam';
const SERVICE = 'myapp';
const DETAIL_PATH = `/services/${NAMESPACE}/${SERVICE}`;

// Tabs that are always present regardless of which datasources are configured
// (they render an empty/setup state when there's no data). "Backend" is the
// merged Endpoints (RED) + Runtime (USE) tab (docs/ia-review-2.md).
const ALWAYS_PRESENT_TABS = ['Overview', 'Alerts', 'Backend', 'Frontend', 'Database'] as const;

// Capability-gated tabs — only rendered when their datasource is detected
// (Issues/Logs need Loki, Dependencies needs service-graph metrics, Traces
// needs Tempo, Profiling needs Pyroscope). Without those in CI these are
// typically absent, so we assert on them conditionally (if the tab exists,
// clicking it must render a state).
const GATED_TABS = ['Issues', 'Dependencies', 'Traces', 'Logs', 'Profiling'] as const;

/** The service-detail tab bar (Grafana <TabsBar> renders role="tablist"). */
function tabList(page: Page) {
  return page.getByRole('tablist');
}

/**
 * Assert that a tab's content area shows a *meaningful* state — a panel, a
 * table, an empty-state, an alert, or a loading placeholder — never a blank
 * screen. `extra` adds tab-specific empty/section text that proves the tab's
 * own code executed (not just a generic shell).
 */
async function expectMeaningfulTabState(page: Page, tabLabel: string, extra: Locator[]) {
  await expectAnyVisible(
    [
      page.getByRole('alert'),
      page.locator('table'),
      page.locator('[data-testid="data-testid panel content"]'),
      page.getByText(/Loading/i),
      ...extra,
    ],
    { message: `"${tabLabel}" tab rendered a blank screen instead of a meaningful state` }
  );
}

test.describe('Service Detail', () => {
  test.beforeEach(async ({ gotoPage }) => {
    await gotoPage(DETAIL_PATH);
  });

  test('renders header and tab bar even without data', async ({ page }) => {
    // Header title is derived from the URL params — must appear regardless of
    // backend availability.
    await expect(page.getByText(`${NAMESPACE}/${SERVICE}`).first()).toBeVisible({ timeout: 15_000 });

    // The tab bar itself proves the detail page mounted (not a blank/error shell).
    await expect(tabList(page).first()).toBeVisible({ timeout: 15_000 });

    // Every always-present tab is offered.
    for (const label of ALWAYS_PRESENT_TABS) {
      await expect(page.getByRole('tab', { name: label, exact: true }).first()).toBeVisible();
    }
  });

  test('legacy tab aliases resolve to the merged Backend tab', async ({ gotoPage, page }) => {
    // docs/url-contract.md promises tab=server / tab=runtime (the former
    // Endpoints/Runtime tabs) resolve to Backend forever — old bookmarks and
    // alert annotations depend on it. Assert they select Backend, not fall
    // back to Overview.
    for (const legacy of ['server', 'runtime']) {
      await gotoPage(`${DETAIL_PATH}?tab=${legacy}`);
      await expect(page.getByRole('tab', { name: 'Backend', exact: true }).first()).toHaveAttribute(
        'aria-selected',
        'true',
        { timeout: 15_000 }
      );
    }
  });

  test('header time picker control is present', async ({ page }) => {
    // The global HeaderTimeControls renders Grafana's TimeRangePicker.
    await expect(page.locator('[data-testid="data-testid TimePicker Open Button"]').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('Overview tab renders a meaningful state', async ({ page }) => {
    await page.getByRole('tab', { name: 'Overview', exact: true }).first().click();
    await expectMeaningfulTabState(page, 'Overview', [
      page.getByText('Operations').first(),
      page.getByText('No operations found').first(),
      page.getByText(/Topology/i).first(),
    ]);
  });

  test('Backend tab renders a meaningful state', async ({ page }) => {
    await page.getByRole('tab', { name: 'Backend', exact: true }).first().click();
    // Backend merges Endpoints (RED, always expanded) with Runtime (USE, in a
    // collapsed section). Assert on the Endpoints surface plus the Runtime
    // collapse header so both halves of the merged tab are proven to mount.
    await expectMeaningfulTabState(page, 'Backend', [
      page.getByText('No endpoint data').first(),
      page.getByText('HTTP Endpoints').first(),
      page.getByRole('heading', { name: 'Endpoints' }).first(),
      page.getByText(/Runtime/).first(),
    ]);
  });

  test('Alerts tab renders a meaningful state', async ({ page }) => {
    await page.getByRole('tab', { name: 'Alerts', exact: true }).first().click();
    await expectMeaningfulTabState(page, 'Alerts', [
      page.getByText('Alert rules').first(),
      page.getByText('Create alert').first(),
      page.getByText(/No alerts|unavailable/i).first(),
    ]);
  });

  test('Frontend tab renders a meaningful state', async ({ page }) => {
    await page.getByRole('tab', { name: 'Frontend', exact: true }).first().click();
    await expectMeaningfulTabState(page, 'Frontend', [
      page.getByText('Frontend Observability').first(),
      page.getByText('No recent measurements').first(),
      page.getByText('Core Web Vitals').first(),
    ]);
  });

  test('Database tab renders a meaningful state', async ({ page }) => {
    await page.getByRole('tab', { name: 'Database', exact: true }).first().click();
    await expectMeaningfulTabState(page, 'Database', [
      page.getByText('No database activity detected').first(),
      page.getByText('Query Operations').first(),
      page.getByText(/database spans|connection-pool/i).first(),
    ]);
  });

  test('capability-gated tabs render a state when present', async ({ page }) => {
    // Without Tempo/Loki/Pyroscope these tabs are hidden. When present, they
    // must render a meaningful state (never a blank screen) on click.
    let checked = 0;
    for (const label of GATED_TABS) {
      const tab = page.getByRole('tab', { name: label, exact: true }).first();
      if (await tab.isVisible().catch(() => false)) {
        checked++;
        await tab.click();
        await expectMeaningfulTabState(page, label, [
          // Filter/search toolbars that these tabs mount even with no data.
          page.getByPlaceholder(/Search/i).first(),
          page.getByText(/No .*(found|data|measurements)/i).first(),
          page.getByText('No data').first(),
          page.getByText('No callers or dependencies detected').first(),
        ]);
      }
    }
    // No assertion on `checked` — zero gated tabs is a valid CI state. The
    // header/tab-bar test already guards the always-present surface.
    expect(checked).toBeGreaterThanOrEqual(0);
  });
});
