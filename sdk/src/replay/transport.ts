/**
 * Chunked, compressed replay transport (nais/grafana-apm-app#58, #67).
 *
 * Wire contract (the plugin reader is built against this — do not deviate):
 * each chunk is one Faro event `faro.session_recording.chunk` with string
 * attributes:
 *   - `chunk_seq`: monotonically increasing integer per session, starting 0
 *   - `mode`:     "snapshot" (#67) or "recording" (#58)
 *   - `enc`:      "gzip+b64" (versions the format)
 *   - `count`:    number of rrweb events in the chunk
 *   - `first_ts`/`last_ts`: epoch ms of first/last rrweb event in the chunk
 *   - `data`:     base64(gzip(JSON.stringify(eventWithTime[]))), ≤ 96 000 chars
 *   - `dropped`:  (optional) events dropped because a single rrweb event
 *                 exceeded the cap on its own
 *
 * Compression: fflate `gzipSync`. Chosen over native `CompressionStream`
 * because it is a single synchronous code path (no stream plumbing, no async
 * fallback fork), ~8 KB, works identically in every browser and in jsdom
 * tests, and the inputs are small (≤ 64 KB buffers; snapshots up to a few MB
 * compress in low tens of ms). This module is only ever loaded lazily, so its
 * size never touches apps that don't opt in.
 */

import { gzipSync } from 'fflate';
import type { eventWithTime } from '@grafana/rrweb';

import {
  MAX_BUFFER_BYTES,
  MAX_BUFFER_MS,
  MAX_CHUNK_B64_CHARS,
  REPLAY_CHUNK_EVENT_NAME,
  REPLAY_ENCODING,
} from './constants.js';
import type { ReplayMode } from './constants.js';

export { REPLAY_CHUNK_EVENT_NAME, REPLAY_ENCODING, MAX_CHUNK_B64_CHARS } from './constants.js';
export type { ReplayMode } from './constants.js';

/** Sink for one chunk event; in production this wraps `faro.api.pushEvent`. */
export type PushChunk = (name: string, attributes: Record<string, string>) => void;

/**
 * Session-scoped `chunk_seq` counter, shared by ALL transports (snapshot and
 * recording) so the sequence stays monotone within one page load / session.
 */
let chunkSeq = 0;

/** @internal test helper */
export function _resetChunkSeqForTesting(): void {
  chunkSeq = 0;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const STRIDE = 0x8000;
  for (let i = 0; i < bytes.length; i += STRIDE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STRIDE));
  }
  return btoa(binary);
}

/** base64(gzip(JSON.stringify(events))) — the `data` attr payload. */
export function encodeEvents(events: readonly eventWithTime[]): string {
  const json = JSON.stringify(events);
  return toBase64(gzipSync(new TextEncoder().encode(json)));
}

interface BuiltChunk {
  data: string;
  events: eventWithTime[];
}

export interface BuildChunksResult {
  chunks: BuiltChunk[];
  /** Events dropped because a single event exceeded the cap on its own. */
  dropped: number;
  droppedFirstTs: number | undefined;
  droppedLastTs: number | undefined;
}

function pack(events: eventWithTime[], maxB64Chars: number, result: BuildChunksResult): void {
  if (events.length === 0) {
    return;
  }
  const data = encodeEvents(events);
  if (data.length <= maxB64Chars) {
    result.chunks.push({ data, events });
    return;
  }
  if (events.length === 1) {
    // A single rrweb event larger than the cap: drop it and account for it.
    const ts = events[0]!.timestamp;
    result.dropped += 1;
    result.droppedFirstTs = result.droppedFirstTs === undefined ? ts : Math.min(result.droppedFirstTs, ts);
    result.droppedLastTs = result.droppedLastTs === undefined ? ts : Math.max(result.droppedLastTs, ts);
    return;
  }
  const mid = Math.ceil(events.length / 2);
  pack(events.slice(0, mid), maxB64Chars, result);
  pack(events.slice(mid), maxB64Chars, result);
}

/**
 * Split an event array into encoded chunks whose `data` never exceeds
 * `maxB64Chars` (binary split, order-preserving).
 */
export function buildChunks(
  events: readonly eventWithTime[],
  maxB64Chars: number = MAX_CHUNK_B64_CHARS
): BuildChunksResult {
  const result: BuildChunksResult = {
    chunks: [],
    dropped: 0,
    droppedFirstTs: undefined,
    droppedLastTs: undefined,
  };
  pack([...events], maxB64Chars, result);
  return result;
}

/**
 * Chunk, compress and push an event batch per the wire contract. Assigns the
 * session-scoped `chunk_seq`. Never throws.
 */
export function sendEvents(events: readonly eventWithTime[], mode: ReplayMode, push: PushChunk): void {
  try {
    if (events.length === 0) {
      return;
    }
    const { chunks, dropped, droppedFirstTs, droppedLastTs } = buildChunks(events);
    if (chunks.length === 0 && dropped > 0) {
      // Everything was dropped; emit an empty carrier chunk so the reader
      // still sees the loss.
      chunks.push({ data: encodeEvents([]), events: [] });
    }
    chunks.forEach((chunk, index) => {
      const first = chunk.events[0];
      const last = chunk.events[chunk.events.length - 1];
      const attributes: Record<string, string> = {
        chunk_seq: String(chunkSeq++),
        mode,
        enc: REPLAY_ENCODING,
        count: String(chunk.events.length),
        first_ts: String(first?.timestamp ?? droppedFirstTs ?? Date.now()),
        last_ts: String(last?.timestamp ?? droppedLastTs ?? Date.now()),
        data: chunk.data,
      };
      if (index === 0 && dropped > 0) {
        attributes['dropped'] = String(dropped);
      }
      push(REPLAY_CHUNK_EVENT_NAME, attributes);
    });
  } catch {
    // Transport must never break the host app (or error reporting itself).
  }
}

/**
 * Buffering front-end: accumulates rrweb events and flushes a chunk batch
 * after ≤ `MAX_BUFFER_MS` or once ≥ `MAX_BUFFER_BYTES` of serialized JSON has
 * accumulated, whichever comes first.
 */
export class ReplayTransport {
  private buffer: eventWithTime[] = [];
  private bufferedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly mode: ReplayMode,
    private readonly push: PushChunk,
    private readonly maxBufferMs: number = MAX_BUFFER_MS,
    private readonly maxBufferBytes: number = MAX_BUFFER_BYTES
  ) {}

  enqueue(event: eventWithTime): void {
    try {
      this.buffer.push(event);
      try {
        this.bufferedBytes += JSON.stringify(event).length;
      } catch {
        this.bufferedBytes += 1024; // unserializable events are re-attempted at flush
      }
      if (this.bufferedBytes >= this.maxBufferBytes) {
        this.flush();
        return;
      }
      if (this.timer === undefined) {
        this.timer = setTimeout(() => this.flush(), this.maxBufferMs);
      }
    } catch {
      // Never break the host app.
    }
  }

  enqueueAll(events: readonly eventWithTime[]): void {
    for (const event of events) {
      this.enqueue(event);
    }
  }

  /** Flush pending events immediately (also used for the on-error ring buffer). */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) {
      return;
    }
    const events = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    sendEvents(events, this.mode, this.push);
  }

  /** Flush and stop the timer; the transport can still be reused afterwards. */
  dispose(): void {
    this.flush();
  }
}
