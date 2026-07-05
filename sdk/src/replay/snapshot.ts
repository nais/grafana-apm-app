/**
 * Masked DOM snapshot on crash — "screenshot on error" (nais/grafana-apm-app#67).
 *
 * `captureSnapshot()` serializes the current document with rrweb-snapshot
 * under the non-overridable masking floor, wraps the result as a synthetic
 * one-frame replay — `[Meta (type 4), FullSnapshot (type 2)]` — and ships it
 * through the chunked transport with `mode="snapshot"`, renderable by the
 * exact player #58 ships, paused at t=0.
 *
 * Guardrails:
 *   - skip when the document has more than 15 000 nodes (capture jank),
 *   - throttle: max 1 snapshot per error-message hash per session (proxy for
 *     the fingerprint, which is not known SDK-side before #62 tier 0),
 *   - hard cap of 3 snapshots per session,
 *   - everything wrapped in try/catch — a failing snapshot must never break
 *     error reporting itself.
 */

import type { eventWithTime } from '@grafana/rrweb';

import { hashString } from './hash.js';
import { buildSnapshotMaskingOptions } from './masking.js';
import { sendEvents } from './transport.js';
import type { PushChunk } from './transport.js';

export const MAX_SNAPSHOT_DOM_NODES = 15_000;
export const MAX_SNAPSHOTS_PER_SESSION = 3;

/** rrweb event types used for the synthetic one-frame replay. */
const RRWEB_TYPE_FULL_SNAPSHOT = 2;
const RRWEB_TYPE_META = 4;

let snapshotCount = 0;
const capturedErrorHashes = new Set<string>();

/** @internal test helper */
export function _resetSnapshotStateForTesting(): void {
  snapshotCount = 0;
  capturedErrorHashes.clear();
}

/** Stable throttling key for an error message (djb2, hex). */
export function hashErrorMessage(message: string): string {
  return hashString(message).toString(16);
}

type SnapshotFn = (doc: Document, options?: Record<string, unknown>) => unknown;

export interface CaptureSnapshotOptions {
  /** Extra block selectors (tighten-only), from `sessionReplay.block`-style config. */
  block?: readonly string[];
  /** @internal test seam: replaces the lazily imported rrweb-snapshot `snapshot`. */
  snapshotFn?: SnapshotFn;
  /** @internal test seam: overrides {@link MAX_SNAPSHOT_DOM_NODES}. */
  maxNodes?: number;
}

/**
 * Capture one masked DOM snapshot for the given error message and push it as
 * `mode="snapshot"` chunk(s). Returns `true` when a snapshot was sent, `false`
 * when skipped (throttled, oversized DOM, or capture failure). Never throws.
 */
export async function captureSnapshot(
  errorMessage: string,
  push: PushChunk,
  options: CaptureSnapshotOptions = {}
): Promise<boolean> {
  try {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return false;
    }
    if (snapshotCount >= MAX_SNAPSHOTS_PER_SESSION) {
      return false;
    }
    const hash = hashErrorMessage(errorMessage);
    if (capturedErrorHashes.has(hash)) {
      return false;
    }
    const maxNodes = options.maxNodes ?? MAX_SNAPSHOT_DOM_NODES;
    if (document.getElementsByTagName('*').length > maxNodes) {
      return false;
    }

    // Consume the throttle slot before capturing so an error storm on a page
    // where capture keeps failing cannot retry the (expensive) traversal.
    capturedErrorHashes.add(hash);
    snapshotCount += 1;

    const snapshotFn = options.snapshotFn ?? (await import('@grafana/rrweb-snapshot')).snapshot;
    const node = snapshotFn(document, { ...buildSnapshotMaskingOptions(options.block) });
    if (node == null) {
      return false;
    }

    const timestamp = Date.now();
    const events = [
      {
        type: RRWEB_TYPE_META,
        data: {
          href: window.location.href,
          width: window.innerWidth,
          height: window.innerHeight,
        },
        timestamp,
      },
      {
        type: RRWEB_TYPE_FULL_SNAPSHOT,
        data: {
          node,
          initialOffset: { left: window.scrollX || 0, top: window.scrollY || 0 },
        },
        timestamp,
      },
    ] as unknown as eventWithTime[];

    sendEvents(events, 'snapshot', push);
    return true;
  } catch {
    return false;
  }
}
