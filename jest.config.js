// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

const path = require('path');

const scaffoldConfig = require('./.config/jest.config');

// `react-router` is a webpack external in the real bundle (.config/bundler/externals.ts):
// Grafana hands the plugin its single instance. Under jest there is no external, and pnpm
// can install two copies — react-router-dom pins one exact version, @grafana/ui's
// react-router-dom-v5-compat (behind <TextLink>) pins another — which yields two Router
// contexts, so a <MemoryRouter> from one is invisible to a link from the other. Collapse
// both onto the copy react-router-dom uses, mirroring what the browser bundle does.
const reactRouterPath = require.resolve('react-router', {
  paths: [path.dirname(require.resolve('react-router-dom/package.json'))],
});

module.exports = {
  // Jest configuration provided by Grafana scaffolding
  ...scaffoldConfig,
  moduleNameMapper: { ...scaffoldConfig.moduleNameMapper, '^react-router$': reactRouterPath },
  // The scaffold only matches src/**; also run the seed-generator tests (#90).
  testMatch: [...scaffoldConfig.testMatch, '<rootDir>/scripts/seed/**/*.test.{ts,tsx}'],
};
