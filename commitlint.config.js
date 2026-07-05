// Conventional Commits rules for nais-apm-app. This underpins release-please's
// version inference and CHANGELOG generation. package.json has no "type": "module",
// so this file is CommonJS (module.exports) — unlike the @nais/apm SDK's ESM variant.
module.exports = {
  extends: ['@commitlint/config-conventional'],
};
