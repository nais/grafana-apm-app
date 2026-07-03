/** @internal Shared module state between init() and the Sentry-compat API. */

import type { Faro } from '@grafana/faro-web-sdk';

interface ApmState {
  faro: Faro | undefined;
  /** Module-level context merged into every pushError context (setTag/setContext). */
  globalContext: Record<string, string>;
  warnedNotInitialized: boolean;
}

const state: ApmState = {
  faro: undefined,
  globalContext: {},
  warnedNotInitialized: false,
};

export function setFaroInstance(faro: Faro | undefined): void {
  state.faro = faro;
}

export function getFaroInstance(): Faro | undefined {
  if (!state.faro && !state.warnedNotInitialized) {
    state.warnedNotInitialized = true;
    // eslint-disable-next-line no-console
    console.warn('[@nais/apm] Called before init(); the call is a no-op. Call init() first.');
  }
  return state.faro;
}

export function isInitialized(): boolean {
  return state.faro !== undefined;
}

/** @internal Like getFaroInstance but never warns; for init()'s double-init path. */
export function getStoredFaro(): Faro | undefined {
  return state.faro;
}

export function getGlobalContext(): Record<string, string> {
  return state.globalContext;
}

/** @internal test helper */
export function _resetStateForTesting(): void {
  state.faro = undefined;
  state.globalContext = {};
  state.warnedNotInitialized = false;
}
