#!/usr/bin/env node
/**
 * Bundle budget check for the initial plugin bundle (dist/module.js).
 *
 * History (see AGENTS.md → Gotchas): v0.13.2 disabled code-splitting entirely
 * (LimitChunkCountPlugin maxChunks:1) after a production ChunkLoadError caused
 * by auto-split chunks being deleted on redeploy. Code-splitting is now
 * re-enabled for EXPLICIT `import()` boundaries only (splitChunks: false), so
 * heavy lazy features (rrweb replay player) must never leak into module.js.
 * This script fails the build if the initial bundle grows past its budget —
 * the usual cause is a heavy dependency being imported statically instead of
 * through a guarded `import()`.
 *
 * Baseline: 3,053,298 bytes (v0.13.4 production build, 2026-07-03) + 10%.
 * If you grow the bundle intentionally, rebase the baseline in this file and
 * say so in your PR.
 */
const fs = require('fs');
const path = require('path');

const BASELINE_BYTES = 3053298;
const LIMIT_BYTES = Math.round(BASELINE_BYTES * 1.1);

const distDir = path.resolve(__dirname, '..', 'dist');
const moduleJs = path.join(distDir, 'module.js');

function fmt(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes.toLocaleString('en-US')} bytes)`;
}

if (!fs.existsSync(moduleJs)) {
  console.error(`check-bundle-size: ${moduleJs} not found — run the production build first.`);
  process.exit(1);
}

const size = fs.statSync(moduleJs).size;

// Informational: list emitted lazy chunks so regressions in splitting are visible.
const chunks = fs
  .readdirSync(distDir)
  .filter((f) => f.endsWith('.js') && f !== 'module.js')
  .map((f) => `  ${f}: ${fmt(fs.statSync(path.join(distDir, f)).size)}`);

console.log(`check-bundle-size: dist/module.js = ${fmt(size)} (budget ${fmt(LIMIT_BYTES)})`);
if (chunks.length > 0) {
  console.log('check-bundle-size: lazy chunks:');
  console.log(chunks.join('\n'));
}

if (size > LIMIT_BYTES) {
  console.error(
    `check-bundle-size: FAIL — dist/module.js exceeds the bundle budget by ${fmt(size - LIMIT_BYTES)}.\n` +
      'A heavy dependency probably landed in the initial bundle. Load it via a guarded dynamic import() ' +
      '(see src/pages/tabs/frontend/replay/LazyReplayPlayer.tsx), or rebase BASELINE_BYTES in scripts/check-bundle-size.js ' +
      'if the growth is intentional.'
  );
  process.exit(1);
}
console.log('check-bundle-size: OK');
