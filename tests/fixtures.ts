import { AppConfigPage, AppPage, test as base, expect } from '@grafana/plugin-e2e';
import type { Locator, Page } from '@playwright/test';
import pluginJson from '../src/plugin.json';

// ─── Constants ────────────────────────────────────────────────────────
export const PLUGIN_ID = pluginJson.id;
export const PLUGIN_ROOT = `/a/${PLUGIN_ID}`;

// ─── Utilities ────────────────────────────────────────────────────────

/**
 * Dismiss Grafana overlays (e.g. "What's new" carousel in Grafana 13+)
 * that block plugin content. Idempotent — safe to call multiple times.
 */
export async function dismissOverlays(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  const closeBtn = page.locator('button[aria-label="Close"]').first();
  try {
    await closeBtn.waitFor({ state: 'visible', timeout: 3000 });
    await closeBtn.click();
    await closeBtn.waitFor({ state: 'hidden', timeout: 2000 });
  } catch {
    // No overlay present — nothing to dismiss
  }
}

/**
 * Wait for any one of the provided locators to become visible.
 * Returns the first locator that matched.
 * Fails with a clear message if none become visible within the timeout.
 */
export async function expectAnyVisible(
  locators: Locator[],
  { timeout = 15_000, message }: { timeout?: number; message?: string } = {}
): Promise<Locator> {
  const deadline = Date.now() + timeout;
  const poll = 500;

  while (Date.now() < deadline) {
    for (const loc of locators) {
      if (await loc.isVisible().catch(() => false)) {
        return loc;
      }
    }
    await new Promise((r) => setTimeout(r, poll));
  }

  const descriptions = locators.map((l) => l.toString()).join(', ');
  throw new Error(message ?? `None of the locators became visible within ${timeout}ms: [${descriptions}]`);
}

// ─── Fixtures ─────────────────────────────────────────────────────────

type AppTestFixture = {
  /** Navigate to the plugin AppConfig page (admin). Overlays auto-dismissed. */
  appConfigPage: AppConfigPage;
  /** Navigate to a plugin page by sub-path (e.g. '/services'). Overlays auto-dismissed. */
  gotoPage: (path?: string) => Promise<AppPage>;
};

export const test = base.extend<AppTestFixture>({
  appConfigPage: async ({ gotoAppConfigPage, page }, use) => {
    const configPage = await gotoAppConfigPage({ pluginId: PLUGIN_ID });
    await dismissOverlays(page);
    await use(configPage);
  },
  gotoPage: async ({ gotoAppPage, page }, use) => {
    await use(async (path) => {
      const appPage = await gotoAppPage({ path, pluginId: PLUGIN_ID });
      await dismissOverlays(page);
      return appPage;
    });
  },
});

export { expect };
