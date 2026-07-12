/**
 * CLI for the deterministic Faro telemetry generator (#90).
 *
 * Runs on Node 22 without a build step:
 *
 *   pnpm seed                                  # NDJSON to stdout (dry run)
 *   pnpm seed --url http://localhost:12347/collect
 *   pnpm seed --seed 7 --duration 60           # different but still deterministic
 *
 * Content is fully determined by (seed, base, duration); only the clock base
 * defaults to "now" so freshly seeded data lands in dashboards' default time
 * range. Pass --base <epoch-ms> for byte-reproducible output.
 */
import { generateScenario } from './generator.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const url = arg('url');
  const payloads = generateScenario({
    seed: Number(arg('seed') ?? 42),
    baseTimeMs: Number(arg('base') ?? Date.now()),
    durationMinutes: Number(arg('duration') ?? 30),
    sessionsPerApp: Number(arg('sessions') ?? 4),
  });

  if (!url) {
    for (const payload of payloads) {
      process.stdout.write(JSON.stringify(payload) + '\n');
    }
    process.stderr.write(`[seed] dry run: ${payloads.length} payloads to stdout (pass --url to send)\n`);
    return;
  }

  let sent = 0;
  for (const payload of payloads) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`POST ${url} failed: HTTP ${response.status} after ${sent} payloads`);
    }
    sent++;
  }
  process.stderr.write(`[seed] sent ${sent} payloads to ${url}\n`);
}

main().catch((error) => {
  console.error('[seed]', error);
  process.exit(1);
});
