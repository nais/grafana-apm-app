// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

const scaffoldConfig = require('./.config/jest.config');

module.exports = {
  // Jest configuration provided by Grafana scaffolding
  ...scaffoldConfig,
  // The scaffold only matches src/**; also run the seed-generator tests (#90).
  testMatch: [...scaffoldConfig.testMatch, '<rootDir>/scripts/seed/**/*.test.{ts,tsx}'],
};
