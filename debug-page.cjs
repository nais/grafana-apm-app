const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.goto('http://localhost:3000/a/nais-applicationobservability-app/services/opentelemetry-demo/frontend?from=now-1h&to=now', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await page.waitForTimeout(6000);

  const panels = await page.$$eval('[data-viz-panel-key]', els => els.map(e => ({
    text: e.innerText?.substring(0, 80).replace(/\n/g, ' | '),
    h: e.offsetHeight
  })));
  console.log('Frontend panels:');
  for (const p of panels) {
    console.log(`  h=${p.h} ${p.text}`);
  }

  await page.screenshot({ path: '/tmp/frontend-overview.png', fullPage: true });
  console.log('Screenshot saved');

  await browser.close();
})();
