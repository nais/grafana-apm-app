/**
 * Replacement console-error instrumentation (nais/grafana-apm-app#66, Phase 1).
 *
 * Faro's own console instrumentation only extracts an Error from the *first*
 * argument; `console.error('msg', err)` — the idiom every logger utility uses —
 * gets a synthetic stack polluted with Faro SDK frames and `[object Object]`
 * values. This instrumentation:
 *
 *   1. finds an Error in *any* argument position (Sentry parity) and pushes it
 *      with its ORIGINAL stack, moving the remaining args to
 *      `context.console_message`;
 *   2. otherwise serializes object args as depth-2, 2 KB-capped, circular-safe
 *      JSON (never `[object Object]`, never `{}`) and pushes a synthetic error.
 *
 * Faro must be initialized with `getWebInstrumentations({ captureConsole: false })`
 * so only one console patch is active — `init()` in this package does that.
 */

import { BaseInstrumentation, isError } from '@grafana/faro-web-sdk';

import { serializeConsoleArgs } from './serialize.js';
import { VERSION } from './version.js';

export const CONSOLE_ERROR_PREFIX = 'console.error: ';

export class NaisConsoleInstrumentation extends BaseInstrumentation {
  readonly name = '@nais/apm-console-instrumentation';
  readonly version = VERSION;

  private originalConsoleError: Console['error'] | undefined;

  initialize(): void {
    if (this.originalConsoleError) {
      return; // already patched; stay idempotent
    }
    const original = console.error.bind(console);
    this.originalConsoleError = console.error;

    console.error = (...args: unknown[]): void => {
      try {
        this.captureConsoleError(args);
      } catch (err) {
        this.logError('Failed to capture console.error call', err);
      }
      original(...args);
    };
  }

  destroy(): void {
    if (this.originalConsoleError) {
      console.error = this.originalConsoleError;
      this.originalConsoleError = undefined;
    }
  }

  private captureConsoleError(args: unknown[]): void {
    const error = args.find((arg): arg is Error => isError(arg));

    if (error) {
      // Real Error found (any position): push it as-is so Faro parses the
      // ORIGINAL stack; preserve the remaining args as context.
      const rest = args.filter((arg) => arg !== error);
      this.api.pushError(
        error,
        rest.length > 0 ? { context: { console_message: serializeConsoleArgs(rest) } } : undefined
      );
      return;
    }

    // No Error anywhere: an honest synthetic error with a readable message.
    const message = serializeConsoleArgs(args);
    this.api.pushError(new Error(CONSOLE_ERROR_PREFIX + message));
  }
}
