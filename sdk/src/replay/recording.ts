/**
 * Error-triggered / continuous session recording (nais/grafana-apm-app#58).
 *
 * `startRecording()` runs rrweb `record()` (Grafana's fork) with
 * `checkoutEveryNms: 60_000` and the non-overridable masking floor.
 *
 *   - `mode: 'on-error'` (default): the last two checkout segments
 *     (~60–120 s) are kept in a memory ring buffer; nothing leaves the
 *     browser. On the first captured error the buffer is flushed through the
 *     chunked transport (`mode="recording"`) and recording keeps streaming for
 *     the rest of the session (Sentry semantics).
 *   - `mode: 'always'`: streams continuously, gated by a deterministic
 *     per-session `sampleRate`.
 */

import type { eventWithTime } from '@grafana/rrweb';

import { hashString } from './hash.js';
import { buildRecordMaskingOptions } from './masking.js';
import { ReplayTransport } from './transport.js';
import type { PushChunk } from './transport.js';

export const CHECKOUT_EVERY_NMS = 60_000;

const RRWEB_TYPE_FULL_SNAPSHOT = 2;
const RRWEB_TYPE_META = 4;

/**
 * Deterministic per-session sampling: the same session id always lands on the
 * same side of the rate, so a session is either fully recorded or not at all.
 * Falls back to a single random draw when no session id is available.
 */
export function isSessionSampled(sessionId: string | undefined, sampleRate: number): boolean {
  if (!(sampleRate > 0)) {
    return false;
  }
  if (sampleRate >= 1) {
    return true;
  }
  if (sessionId === undefined || sessionId === '') {
    return Math.random() < sampleRate;
  }
  return hashString(sessionId) / 0x1_0000_0000 < sampleRate;
}

type StopFn = () => void;
type RecordFn = (options: {
  emit: (event: eventWithTime, isCheckout?: boolean) => void;
  checkoutEveryNms: number;
  [key: string]: unknown;
}) => StopFn | undefined;

export interface RecordingHandle {
  /**
   * Notify the recorder that an error was captured. In `on-error` mode the
   * first call flushes the ring buffer and switches to streaming; subsequent
   * calls (and all calls in `always` mode) are no-ops.
   */
  notifyError(): void;
  /** Stop recording and flush whatever is already streaming. */
  stop(): void;
  /** True once events are being streamed (always-mode, or after the first error). */
  readonly isStreaming: boolean;
}

export interface StartRecordingOptions {
  mode: 'on-error' | 'always';
  /** Fraction of sessions recorded, 0..1. Default 1. */
  sampleRate?: number;
  /** Extra block selectors (tighten-only). */
  block?: readonly string[];
  push: PushChunk;
  /** Faro session id, used for deterministic sampling. */
  sessionId?: string;
  /** @internal test seam: replaces the lazily imported rrweb `record`. */
  recordFn?: RecordFn;
}

/**
 * Start recording. Resolves to `undefined` when the session is sampled out or
 * rrweb fails to start; never throws.
 */
export async function startRecording(options: StartRecordingOptions): Promise<RecordingHandle | undefined> {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }
    if (!isSessionSampled(options.sessionId, options.sampleRate ?? 1)) {
      return undefined;
    }

    const recordFn =
      options.recordFn ?? ((await import('@grafana/rrweb')).record as unknown as RecordFn);
    const transport = new ReplayTransport('recording', options.push);

    let streaming = options.mode === 'always';
    // Ring buffer: the previous completed checkout segment + the one being filled.
    let previousSegment: eventWithTime[] = [];
    let currentSegment: eventWithTime[] = [];

    const emit = (event: eventWithTime, isCheckout?: boolean): void => {
      try {
        if (streaming) {
          transport.enqueue(event);
          return;
        }
        // A checkout emits Meta (type 4) then FullSnapshot (type 2). Rotate the
        // ring on the Meta event; fall back to the FullSnapshot when a checkout
        // arrives without a preceding Meta.
        const lastType = currentSegment[currentSegment.length - 1]?.type;
        const isBoundary =
          currentSegment.length > 0 &&
          (event.type === RRWEB_TYPE_META ||
            (event.type === RRWEB_TYPE_FULL_SNAPSHOT && isCheckout === true && lastType !== RRWEB_TYPE_META));
        if (isBoundary) {
          previousSegment = currentSegment;
          currentSegment = [];
        }
        currentSegment.push(event);
      } catch {
        // Recording must never break the host app.
      }
    };

    const stopFn = recordFn({
      emit,
      checkoutEveryNms: CHECKOUT_EVERY_NMS,
      // The masking floor is spread LAST so nothing can override it.
      ...buildRecordMaskingOptions(options.block),
    });
    if (stopFn === undefined) {
      return undefined;
    }

    return {
      get isStreaming(): boolean {
        return streaming;
      },
      notifyError(): void {
        if (streaming) {
          return;
        }
        streaming = true;
        const buffered = [...previousSegment, ...currentSegment];
        previousSegment = [];
        currentSegment = [];
        // Historical events go out immediately; live events keep streaming
        // through the buffered transport afterwards.
        transport.enqueueAll(buffered);
        transport.flush();
      },
      stop(): void {
        try {
          stopFn();
        } catch {
          // ignore
        }
        transport.dispose();
      },
    };
  } catch {
    return undefined;
  }
}
