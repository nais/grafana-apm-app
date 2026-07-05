/**
 * rrweb replay player (#58/#67) — HEAVY MODULE, never import statically.
 *
 * This file is loaded only through the guarded dynamic import in
 * LazyReplayPlayer.tsx so @grafana/rrweb-player (and its CSS) land in a
 * separate content-hashed chunk instead of the initial module.js bundle.
 *
 * Version pairing: @grafana/rrweb-player is pinned to 2.0.0-grafana.2 —
 * Grafana's rrweb fork. The @nais/apm recorder uses the same fork release;
 * player and recorder MUST come from the same fork version or replay
 * fidelity breaks (rrweb 2.x is alpha, event formats drift).
 */
import React, { useEffect, useRef } from 'react';
import { Alert, Badge, Icon, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import RrwebPlayer from '@grafana/rrweb-player';
import '@grafana/rrweb-player/dist/style.css';
import type { ReplayPlayerProps } from './types';

/** Instance surface we use — the package types the component as a bare Svelte component. */
interface PlayerHandle {
  goto?: (timeOffsetMs: number, play?: boolean) => void;
  pause?: () => void;
  $destroy?: () => void;
}

export default function ReplayPlayer({ events, mode, seekToMs }: ReplayPlayerProps) {
  const styles = useStyles2(getStyles);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isSnapshot = mode === 'snapshot';
  const hasEnoughEvents = events.length >= 2; // rrweb needs Meta + FullSnapshot at minimum

  useEffect(() => {
    const target = containerRef.current;
    if (!target || !hasEnoughEvents) {
      return;
    }

    const player = new RrwebPlayer({
      target,
      props: {
        events: events as any,
        autoPlay: false,
        // Snapshot mode (#67): a single masked frame — no controls, paused at 0.
        showController: !isSnapshot,
        skipInactive: !isSnapshot,
        speedOption: [1, 2, 4, 8],
        width: target.clientWidth || 800,
        height: 480,
      },
    }) as unknown as PlayerHandle;

    if (!isSnapshot && seekToMs !== undefined && events.length > 0) {
      // Seek (paused) to the requested absolute timestamp — the drawer passes
      // exception time minus 10s so playback starts just before the error.
      const offset = Math.max(0, seekToMs - events[0].timestamp);
      player.goto?.(offset, false);
    }

    return () => {
      try {
        player.pause?.();
        player.$destroy?.();
      } catch {
        // Svelte teardown after the drawer unmounted the DOM node — ignore.
      }
    };
  }, [events, isSnapshot, seekToMs, hasEnoughEvents]);

  if (!hasEnoughEvents) {
    return (
      <Alert severity="info" title="Replay incomplete">
        Not enough replay data was captured for this session to render a frame.
      </Alert>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        {isSnapshot ? (
          <Badge text="Masked snapshot" color="blue" icon="camera" />
        ) : (
          <Badge text="Session replay" color="blue" icon="play" />
        )}
        <span className={styles.privacyNotice}>
          <Icon name="shield" size="sm" /> Recorded with all text and inputs masked at capture time.
        </span>
      </div>
      <div ref={containerRef} className={styles.player} data-testid="replay-player-container" />
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  privacyNotice: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    display: inline-flex;
    align-items: center;
    gap: 4px;
  `,
  player: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    overflow: hidden;
    background: ${theme.colors.background.canvas};
    /* The player computes its own size; keep the frame from overflowing the drawer. */
    .rr-player {
      max-width: 100%;
    }
  `,
});
