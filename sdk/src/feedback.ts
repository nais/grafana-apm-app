/**
 * User feedback capture (M6 seed): captures free-text user feedback as a
 * Faro event so it can be joined to a session (via the Faro session id
 * already on every event) and/or an issue (via `fingerprint`) in Loki.
 *
 * Wire contract (the plugin reader is built against this — do not deviate):
 * one Faro event `faro.feedback` with string attributes:
 *   - `message`:     free text, scrubbed (fnr/email/token), trimmed, ≤ 4000 chars
 *   - `category`:    'bug' | 'idea' | 'other' (default 'other')
 *   - `email`:       (optional) user-volunteered contact address; included only
 *                    when explicitly passed AND shaped like an email — this is
 *                    NOT run through the PII email scrubber (it would just
 *                    replace the whole value with `[email]`), it is validated
 *                    instead
 *   - `fingerprint`: (optional) joins the feedback to a specific issue
 *   - `ctx_<key>`:   (optional) flattened caller-supplied context
 */

import { getFaroInstance } from './internal.js';
import { scrubString } from './scrub.js';

/** Faro event name emitted by {@link captureFeedback}. */
export const FEEDBACK_EVENT_NAME = 'faro.feedback';

/** Caps the message length so a runaway paste can't blow up the Loki line. */
const MAX_MESSAGE_LENGTH = 4000;

/** Deliberately permissive — this only guards against obvious non-emails, not RFC 5322 validation. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FeedbackCategory = 'bug' | 'idea' | 'other';

export interface CaptureFeedbackOptions {
  /** Defaults to 'other'. */
  category?: FeedbackCategory;
  /** User-volunteered contact address. Only sent when it looks email-shaped. */
  email?: string;
  /** Extra key/value context, flattened onto the event as `ctx_<key>` (scrubbed like `message`). */
  context?: Record<string, string>;
  /** Custom grouping key so feedback can be joined to a specific issue (see captureException's `fingerprint`). */
  fingerprint?: string;
}

/**
 * Capture free-text user feedback. Sentry has no direct equivalent — this is
 * `@nais/apm`'s own addition (nais/grafana-apm-app#68 M6). No-op before
 * `init()` (a warning is emitted once by the shared Faro-instance guard).
 */
export function captureFeedback(message: string, options: CaptureFeedbackOptions = {}): void {
  const faro = getFaroInstance();
  if (!faro) {
    return;
  }

  const trimmed = message.trim().slice(0, MAX_MESSAGE_LENGTH);
  if (trimmed === '') {
    return;
  }

  const attributes: Record<string, string> = {
    message: scrubString(trimmed),
    category: options.category ?? 'other',
  };

  if (options.email !== undefined) {
    const email = options.email.trim();
    if (EMAIL_SHAPE.test(email)) {
      attributes['email'] = email;
    }
  }

  if (options.fingerprint !== undefined) {
    attributes['fingerprint'] = options.fingerprint;
  }

  for (const [key, value] of Object.entries(options.context ?? {})) {
    if (value !== undefined) {
      attributes[`ctx_${key}`] = scrubString(value);
    }
  }

  faro.api.pushEvent(FEEDBACK_EVENT_NAME, attributes);
}
