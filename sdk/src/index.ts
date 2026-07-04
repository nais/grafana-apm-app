/**
 * @nais/apm — opinionated Faro wrapper with a Sentry-like DX for nais apps.
 *
 * Phase 0 surface: `init`, `captureException`, `captureMessage`, `setUser`,
 * `clearUser`, `setTag`, `setContext`. Tracing and React helpers
 * (`@nais/apm/react`) are intentionally NOT part of Phase 0.
 */

import {
  ConsoleTransport,
  getWebInstrumentations,
  initializeFaro,
} from '@grafana/faro-web-sdk';
import type { BeforeSendHook, BrowserConfig, Faro, Patterns } from '@grafana/faro-web-sdk';

import { resolveConfig } from './config.js';
import type { ConfigOptions } from './config.js';
import { NaisConsoleInstrumentation } from './console.js';
import { getStoredFaro, setFaroInstance } from './internal.js';
import { composeBeforeSend } from './scrub.js';

export { captureException, captureMessage, setUser, clearUser, setTag, setContext } from './api.js';
export type { CaptureExceptionOptions, SeverityLevel, User } from './api.js';
export { captureFeedback, FEEDBACK_EVENT_NAME } from './feedback.js';
export type { CaptureFeedbackOptions, FeedbackCategory } from './feedback.js';
export { resolveConfig, versionFromImage } from './config.js';
export type { ConfigOptions, ResolvedConfig } from './config.js';
export { NaisConsoleInstrumentation, CONSOLE_ERROR_PREFIX } from './console.js';
export { scrubString } from './scrub.js';
export { isInitialized } from './internal.js';
export { VERSION } from './version.js';

/**
 * Default noise filters: browser-extension frames, benign ResizeObserver
 * loops, and cross-origin "Script error." events without information.
 */
export const DEFAULT_IGNORE_ERRORS: Patterns = [
  'chrome-extension://',
  'moz-extension://',
  'safari-extension://',
  'safari-web-extension://',
  /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/,
  /^Script error\.?$/,
];

export interface InitOptions extends ConfigOptions {
  /**
   * Runs before the mandatory PII scrubber. Return `null` to drop the item.
   * The scrubber always runs last.
   */
  beforeSend?: BeforeSendHook;
  /** Extra patterns appended to {@link DEFAULT_IGNORE_ERRORS}. */
  ignoreErrors?: Patterns;
  /**
   * Disable the built-in PII scrubbing (fødselsnummer, emails, token URLs).
   * You almost certainly do not want this; you take over GDPR responsibility
   * for everything your app sends to Loki.
   */
  dangerouslyDisablePiiScrubbing?: boolean;
  /**
   * Escape hatch: raw Faro `BrowserConfig` overrides merged last (except
   * `beforeSend`, which stays composed with the scrubber). Prefer the
   * top-level options.
   */
  faro?: Partial<BrowserConfig>;
  /**
   * Error-triggered session replay (nais/grafana-apm-app#58). Off by default —
   * opt-in per app, and the recording is masked at capture time by a
   * non-overridable privacy floor (all text and inputs; unmasking only via
   * explicit `data-apm-unmask` markup). `block` can only tighten masking.
   */
  sessionReplay?: {
    enabled?: boolean;
    /** 'on-error' (default): buffer in memory, send only once an error occurs. */
    mode?: 'on-error' | 'always';
    /** Fraction of sessions recorded, 0..1 (default 1). */
    sampleRate?: number;
    /** Extra CSS selectors to block entirely (tighten-only). */
    block?: string[];
  };
  /**
   * Capture one masked DOM snapshot per new error (nais/grafana-apm-app#67).
   * Works without sessionReplay; automatically off when sessionReplay is
   * enabled (a recording's checkout already contains the snapshot).
   */
  screenshotOnError?: boolean;
}

/**
 * Initialize @nais/apm. Zero-config on nais: app name, version, environment
 * and collector URL are resolved from nais meta tags or build-time env; with
 * no collector resolved (local dev) all telemetry is echoed to the console.
 *
 * Note: tracing is not part of Phase 0 — a `tracing` option will arrive with
 * `@grafana/faro-web-tracing` lazy-loading in a later release.
 */
export function init(options: InitOptions = {}): Faro {
  const existing = getStoredFaro();
  if (existing) {
    // eslint-disable-next-line no-console
    console.warn('[@nais/apm] init() called more than once; returning the existing instance.');
    return existing;
  }

  const config = resolveConfig(options);

  const browserConfig: BrowserConfig = {
    app: {
      name: config.app,
      version: config.version,
      environment: config.environment,
      // `release` mirrors `version` so exception grouping and release tagging
      // in the Nais APM plugin line up with the deployed image.
      release: config.version,
    },
    instrumentations: [
      // captureConsole MUST stay false: NaisConsoleInstrumentation is the only
      // console patch (see nais/grafana-apm-app#66).
      ...getWebInstrumentations({ captureConsole: false }),
      new NaisConsoleInstrumentation(),
    ],
    ignoreErrors: [...DEFAULT_IGNORE_ERRORS, ...(options.ignoreErrors ?? [])],
    ...(config.devMode
      ? { transports: [new ConsoleTransport()] }
      : { url: config.telemetryUrl }),
    ...options.faro,
    beforeSend: composeBeforeSend(
      options.beforeSend ?? options.faro?.beforeSend,
      options.dangerouslyDisablePiiScrubbing === true
    ),
  };

  // Replay/snapshot error trigger: the composed beforeSend sees every
  // exception item regardless of capture path (uncaught, unhandledrejection,
  // captureException, console capture) — one choke point, set after the
  // lazily imported replay machinery is ready.
  let onErrorItem: ((message: string) => void) | undefined;
  const composed = browserConfig.beforeSend!;
  browserConfig.beforeSend = (item) => {
    const result = composed(item);
    if (result && onErrorItem && (item as { type?: string }).type === 'exception') {
      const payload = (item as { payload?: { value?: unknown } }).payload;
      onErrorItem(String(payload?.value ?? ''));
    }
    return result;
  };

  const faro = initializeFaro(browserConfig);
  setFaroInstance(faro);

  const replay = options.sessionReplay;
  const wantRecording = replay?.enabled === true;
  const wantSnapshot = options.screenshotOnError === true && !wantRecording;
  if (wantRecording || wantSnapshot) {
    const push = (name: string, attributes: Record<string, string>): void => {
      faro.api.pushEvent(name, attributes);
    };
    if (wantRecording) {
      void import('./replay/recording.js')
        .then(({ startRecording }) =>
          startRecording({
            mode: replay?.mode ?? 'on-error',
            sampleRate: replay?.sampleRate,
            block: replay?.block,
            push,
            sessionId: faro.api.getSession?.()?.id,
          })
        )
        .then((handle) => {
          if (handle) {
            onErrorItem = () => handle.notifyError();
          }
        })
        .catch(() => {});
    } else {
      void import('./replay/snapshot.js')
        .then(({ captureSnapshot }) => {
          onErrorItem = (message) => {
            void captureSnapshot(message, push, { block: replay?.block });
          };
        })
        .catch(() => {});
    }
  }

  return faro;
}
