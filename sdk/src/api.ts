/**
 * Sentry-compatible convenience API on top of Faro.
 *
 * Mapping:
 *   - `captureException(err, { context, fingerprint })` → `faro.api.pushError`
 *     (`fingerprint` becomes `context.fingerprint`, consumed by the owned
 *     fingerprinting pipeline, nais/grafana-apm-app#62)
 *   - `captureMessage(msg, level)` → `faro.api.pushLog`
 *   - `setUser` / `clearUser` → `faro.api.setUser` / `faro.api.resetUser`
 *   - `setTag` / `setContext` → module-level context merged into every
 *     pushError context. Faro has no first-class tag concept, so this is an
 *     approximation: values ride along as exception context, they are not
 *     indexed labels.
 */

import { LogLevel } from '@grafana/faro-web-sdk';
import type { MetaUser } from '@grafana/faro-web-sdk';

import { getFaroInstance, getGlobalContext } from './internal.js';

export interface CaptureExceptionOptions {
  /** Extra key/value context attached to the exception. Values are stringified. */
  context?: Record<string, unknown>;
  /** Custom grouping key; mapped to `context.fingerprint` (see #62). */
  fingerprint?: string;
}

export type SeverityLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

const SEVERITY_TO_LOG_LEVEL: Record<SeverityLevel, LogLevel> = {
  fatal: LogLevel.ERROR, // Faro has no `fatal`; documented approximation
  error: LogLevel.ERROR,
  warning: LogLevel.WARN,
  log: LogLevel.LOG,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
};

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function stringifyContext(context: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(context ?? {})) {
    if (value !== undefined) {
      out[key] = stringifyValue(value);
    }
  }
  return out;
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'string') {
    return new Error(value);
  }
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

/**
 * Capture an exception. Sentry-compatible replacement for
 * `Sentry.captureException`. Note: Faro's `pushError` returns no event ID.
 */
export function captureException(error: unknown, options: CaptureExceptionOptions = {}): void {
  const faro = getFaroInstance();
  if (!faro) {
    return;
  }
  const context: Record<string, string> = {
    ...getGlobalContext(),
    ...stringifyContext(options.context),
  };
  if (options.fingerprint !== undefined) {
    context['fingerprint'] = options.fingerprint;
  }
  faro.api.pushError(toError(error), Object.keys(context).length > 0 ? { context } : undefined);
}

/** Capture a message as a log line. Replacement for `Sentry.captureMessage`. */
export function captureMessage(message: string, level: SeverityLevel = 'info'): void {
  const faro = getFaroInstance();
  if (!faro) {
    return;
  }
  const globalContext = getGlobalContext();
  faro.api.pushLog([message], {
    level: SEVERITY_TO_LOG_LEVEL[level] ?? LogLevel.INFO,
    context: Object.keys(globalContext).length > 0 ? { ...globalContext } : undefined,
  });
}

export interface User {
  id?: string;
  email?: string;
  username?: string;
  attributes?: Record<string, string>;
}

/** Set the active user. Replacement for `Sentry.setUser(user)`. */
export function setUser(user: User | null): void {
  const faro = getFaroInstance();
  if (!faro) {
    return;
  }
  if (user === null) {
    faro.api.resetUser();
    return;
  }
  faro.api.setUser(user satisfies MetaUser);
}

/** Clear the active user. Replacement for `Sentry.setUser(null)`. */
export function clearUser(): void {
  const faro = getFaroInstance();
  if (!faro) {
    return;
  }
  faro.api.resetUser();
}

/**
 * Set a tag merged into every subsequent `captureException`/`captureMessage`
 * context. Approximation of `Sentry.setTag` — Faro has no tag concept.
 */
export function setTag(key: string, value: string | number | boolean): void {
  getGlobalContext()[key] = String(value);
}

/**
 * Attach named context merged (flattened as `name.key`) into every subsequent
 * capture. Approximation of `Sentry.setContext`. Pass `null` to remove.
 */
export function setContext(name: string, context: Record<string, unknown> | null): void {
  const globalContext = getGlobalContext();
  if (context === null) {
    const prefix = `${name}.`;
    for (const key of Object.keys(globalContext)) {
      if (key.startsWith(prefix)) {
        delete globalContext[key];
      }
    }
    return;
  }
  for (const [key, value] of Object.entries(stringifyContext(context))) {
    globalContext[`${name}.${key}`] = value;
  }
}
