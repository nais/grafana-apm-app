/**
 * PII scrubbing pipeline, applied as a Faro `beforeSend` hook.
 *
 * Rules (in order):
 *   1. Norwegian fødselsnummer (11 digits, optional space after the first 6,
 *      with a date-prefix sanity check covering D-, H- and synthetic numbers) → `[fnr]`
 *   2. Email addresses → `[email]`
 *   3. `token|access_token|id_token|refresh_token|code|state` query-parameter
 *      values in URL-shaped strings (including `page_url` and stack traces) → `[redacted]`
 *
 * The scrubber walks every string in the transport item payload plus
 * `meta.page.url`. A user-supplied `beforeSend` always runs first; the scrubber
 * always runs last and can only be disabled with `dangerouslyDisablePiiScrubbing`.
 *
 * Best-effort by design: regex scrubbing is not a GDPR guarantee.
 */

import type { BeforeSendHook, TransportItem } from '@grafana/faro-web-sdk';

const FNR_CANDIDATE = /\b(\d{6})\s?(\d{5})\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// `:` is excluded from the value so `file.js?token=x:1:2` stack-frame suffixes survive.
const TOKEN_PARAMS = /([?&#](?:access_token|id_token|refresh_token|token|code|state)=)[^&\s#'"<>:]+/gi;

/**
 * Sanity-check that the first six digits of an 11-digit candidate look like a
 * DDMMYY date. Accepts D-numbers (day + 40), H-numbers (month + 40) and
 * synthetic test numbers (month + 80).
 */
function hasPlausibleDatePrefix(dateDigits: string): boolean {
  const day = parseInt(dateDigits.slice(0, 2), 10);
  const month = parseInt(dateDigits.slice(2, 4), 10);
  const dayOk = (day >= 1 && day <= 31) || (day >= 41 && day <= 71);
  const monthOk = (month >= 1 && month <= 12) || (month >= 41 && month <= 52) || (month >= 81 && month <= 92);
  return dayOk && monthOk;
}

/** Scrub a single string. Exposed for reuse and tests. */
export function scrubString(value: string): string {
  let result = value.replace(FNR_CANDIDATE, (match, date: string) =>
    hasPlausibleDatePrefix(date) ? '[fnr]' : match
  );
  result = result.replace(EMAIL, '[email]');
  result = result.replace(TOKEN_PARAMS, '$1[redacted]');
  return result;
}

const MAX_DEPTH = 8;

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (value == null || typeof value !== 'object' || depth >= MAX_DEPTH) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = scrubValue(entry, depth + 1, seen);
  }
  return out;
}

/** Deep-scrub every string in a transport item (payload + page URL), without mutating the input. */
export function scrubTransportItem(item: TransportItem): TransportItem {
  const scrubbed: TransportItem = {
    ...item,
    payload: scrubValue(item.payload, 0, new WeakSet()) as TransportItem['payload'],
  };
  const pageUrl = item.meta?.page?.url;
  if (typeof pageUrl === 'string') {
    scrubbed.meta = {
      ...item.meta,
      page: { ...item.meta.page, url: scrubString(pageUrl) },
    };
  }
  return scrubbed;
}

/**
 * Compose the user's `beforeSend` (runs first, may drop items) with the PII
 * scrubber (always last). Pass `disableScrubbing` only via
 * `dangerouslyDisablePiiScrubbing: true`.
 */
export function composeBeforeSend(
  userBeforeSend: BeforeSendHook | undefined,
  disableScrubbing = false
): BeforeSendHook | undefined {
  if (disableScrubbing) {
    return userBeforeSend;
  }
  return (item) => {
    const afterUser = userBeforeSend ? userBeforeSend(item) : item;
    if (afterUser === null) {
      return null;
    }
    return scrubTransportItem(afterUser);
  };
}
