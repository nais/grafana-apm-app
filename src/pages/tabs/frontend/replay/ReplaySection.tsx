/**
 * Drawer-facing replay section (#58/#67): a "Play replay" / "View snapshot"
 * button that fetches the session's chunks on demand and mounts the
 * lazy-loaded rrweb player. This module is cheap and eagerly bundled — only
 * the player itself (LazyReplayPlayer → ReplayPlayer) lives in a lazy chunk.
 */
import React, { Suspense, useState } from 'react';
import { Alert, Button, Spinner } from '@grafana/ui';
import { fetchReplay, ReplayData, ReplayMode, ReplayQueryOptions } from './fetchReplay';
import { LazyReplayPlayer } from './LazyReplayPlayer';

/** Start recordings this long before the exception so the lead-up is visible. */
const SEEK_LEAD_MS = 10_000;

export interface ReplaySectionProps extends ReplayQueryOptions {
  /** Mode reported by probeReplay — decides the button wording before any chunks are fetched. */
  mode: ReplayMode;
  /** Absolute epoch-ms of the exception, when derivable — recordings seek to this minus 10s. */
  exceptionTsMs?: number;
}

export function ReplaySection({ mode, exceptionTsMs, ...query }: ReplaySectionProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [data, setData] = useState<ReplayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Session switches remount this component (the drawer keys it by
  // sessionId), so no reset-on-change effect is needed here.
  const load = async () => {
    setStatus('loading');
    setError(null);
    try {
      const result = await fetchReplay(query);
      if (result) {
        setData(result);
        setStatus('ready');
      } else {
        setError('No replay chunks found for this session in the selected time range.');
        setStatus('error');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load replay data.');
      setStatus('error');
    }
  };

  if (status === 'idle') {
    const snapshot = mode === 'snapshot';
    return (
      <Button size="sm" variant="secondary" icon={snapshot ? 'camera' : 'play'} onClick={load}>
        {snapshot ? 'View snapshot' : 'Play replay'}
      </Button>
    );
  }

  if (status === 'loading') {
    return (
      <span>
        <Spinner inline /> Loading replay…
      </span>
    );
  }

  if (status === 'error' || !data) {
    return (
      <Alert severity="warning" title="Replay unavailable">
        {error ?? 'Failed to load replay data.'}
      </Alert>
    );
  }

  return (
    <Suspense
      fallback={
        <span>
          <Spinner inline /> Loading player…
        </span>
      }
    >
      <LazyReplayPlayer
        events={data.events}
        mode={data.mode}
        seekToMs={data.mode === 'recording' && exceptionTsMs !== undefined ? exceptionTsMs - SEEK_LEAD_MS : undefined}
      />
    </Suspense>
  );
}
