/**
 * Guarded lazy boundary for the rrweb player chunk.
 *
 * Why the guard exists (AGENTS.md → Gotchas, CHANGELOG v0.13.2): lazy chunks
 * are content-hashed and deleted from dist/ on every plugin redeploy. A
 * browser still running a stale module.js will request a chunk file that no
 * longer exists — that exact failure crashed production config pages in
 * v0.13.2 (ChunkLoadError for 732.js). Every explicit import() in this plugin
 * must therefore degrade to a "reload the page" notice instead of throwing.
 */
import React from 'react';
import { Alert, Button } from '@grafana/ui';
import type { ReplayPlayerProps } from './types';

type PlayerModule = { default: React.ComponentType<ReplayPlayerProps> };

const RETRY_DELAY_MS = 1500;

/** Shown when the chunk is gone (plugin redeployed under a stale module.js). */
function ChunkLoadFallback(_: ReplayPlayerProps) {
  return (
    <Alert severity="warning" title="Replay player unavailable">
      The plugin was redeployed since this page loaded, so the replay player could not be fetched — reload the page and
      try again.
      <div style={{ marginTop: 8 }}>
        <Button size="sm" variant="secondary" icon="sync" onClick={() => window.location.reload()}>
          Reload page
        </Button>
      </div>
    </Alert>
  );
}

async function importPlayerWithRetry(): Promise<PlayerModule> {
  try {
    return await import(/* webpackChunkName: "replay-player" */ './ReplayPlayer');
  } catch {
    // One retry after a short delay covers transient network blips; webpack
    // clears failed chunk promises, so a second import() re-requests the file.
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      return await import(/* webpackChunkName: "replay-player" */ './ReplayPlayer');
    } catch {
      return { default: ChunkLoadFallback };
    }
  }
}

/** Mount inside <React.Suspense>. Never resolves to a throw — worst case is the reload notice. */
export const LazyReplayPlayer = React.lazy(importPlayerWithRetry);
