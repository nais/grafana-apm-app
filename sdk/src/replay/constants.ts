/**
 * Wire-contract constants for the session-replay / snapshot pipeline
 * (nais/grafana-apm-app#58, #67). This module is dependency-free on purpose:
 * it is imported by the eagerly-loaded scrubber as well as the lazily-loaded
 * replay machinery, and must never pull rrweb or fflate into the main bundle.
 */

/**
 * Faro event name for one replay chunk. The Nais APM plugin reader is built
 * against this exact name — do not change without versioning the format.
 */
export const REPLAY_CHUNK_EVENT_NAME = 'faro.session_recording.chunk';

/** Encoding identifier carried in every chunk (`enc` attr); versions the wire format. */
export const REPLAY_ENCODING = 'gzip+b64';

/**
 * Hard cap on the `data` attr (base64 chars) per chunk. Keeps the resulting
 * logfmt line safely under Loki's 256KB default `max_line_size` after Alloy's
 * `event_data_*` flattening.
 */
export const MAX_CHUNK_B64_CHARS = 96_000;

/** Flush the event buffer when this much serialized JSON has accumulated. */
export const MAX_BUFFER_BYTES = 64_000;

/** Flush the event buffer at least this often while events are pending. */
export const MAX_BUFFER_MS = 5_000;

/** Capture mode carried in the `mode` attr of every chunk. */
export type ReplayMode = 'snapshot' | 'recording';
