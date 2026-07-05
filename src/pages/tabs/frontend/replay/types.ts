/**
 * Props shared between the heavy lazy player module (ReplayPlayer.tsx) and
 * its guard (LazyReplayPlayer.tsx). Kept in a tiny standalone module so the
 * eager side never touches the rrweb chunk for a type.
 */
import type { ReplayEventWithTime, ReplayMode } from './fetchReplay';

export interface ReplayPlayerProps {
  events: ReplayEventWithTime[];
  mode: ReplayMode;
  /** Absolute epoch-ms position to seek a recording to (paused). Ignored for snapshots. */
  seekToMs?: number;
}
