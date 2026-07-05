/**
 * In-app stack-frame classification (#66).
 *
 * Mirror of the Go implementation in pkg/plugin/fingerprint/frames.go — both
 * are pinned by the shared golden fixtures in
 * pkg/plugin/fingerprint/testdata/frames.json. Change all three together.
 *
 * Faro's console instrumentation pushes a synthetic Error created inside its
 * own handler, so the top frames of console-captured exceptions are always
 * Faro internals. The drawer collapses those; #62 keeps them out of
 * fingerprints.
 */

const FARO_MARKERS = ['@grafana/faro', 'faro-web-sdk', 'faro-core', 'faro-web-tracing', 'faro-react'];

/**
 * Whether a stack-frame path points at application code, as opposed to SDK
 * internals, vendored dependencies, or runtime plumbing. Handles every path
 * shape we see in Loki: webpack:// URLs from minified builds, plain source
 * paths after source-map resolution (#60), hashed bundle assets, and
 * browser-native frames.
 */
export function isInAppFrame(path: string): boolean {
  const p = path.trim().toLowerCase();
  if (p === '' || p === '?') {
    return false;
  }
  // Browser-native and anonymous frames carry no app location.
  if (p.includes('[native code]') || p.includes('<anonymous>')) {
    return false;
  }
  // Vendored dependencies, regardless of bundler path prefix
  // (covers node_modules/ and pnpm's node_modules/.pnpm/ layouts).
  if (p.includes('node_modules/')) {
    return false;
  }
  // Faro SDK modules. Usually under node_modules/, but source-mapped or
  // vendor-chunked builds can surface bare module paths.
  if (FARO_MARKERS.some((marker) => p.includes(marker))) {
    return false;
  }
  // Webpack runtime plumbing: after stripping the webpack://<namespace>/
  // scheme prefix, runtime frames live under webpack/.
  const rest = stripWebpackScheme(p);
  if (rest !== null && rest.startsWith('webpack/')) {
    return false;
  }
  return true;
}

/** Remove a leading webpack://<namespace>/ prefix; null if not a webpack URL. */
function stripWebpackScheme(p: string): string | null {
  const scheme = 'webpack://';
  if (!p.startsWith(scheme)) {
    return null;
  }
  const rest = p.slice(scheme.length);
  const idx = rest.indexOf('/');
  return idx >= 0 ? rest.slice(idx + 1) : rest;
}

export interface StackFrame {
  /** The original line, whitespace preserved for rendering. */
  raw: string;
  /** True when the line parses as an `at …` frame (vs message/other lines). */
  isFrame: boolean;
  /** Frame location path, without line/column suffix. Empty when unparsable. */
  path: string;
  /** Whether the frame points at application code. Non-frames default to true (never collapse the message). */
  inApp: boolean;
}

// `at fn (path:line:col)` | `at path:line:col` | `at fn (path)` — the location
// is whatever sits inside the parens, or the rest of the line without them.
const FRAME_RE = /^\s*at\s+(?:.*?\s+\()?(.*?)\)?$/;

/** Strip a trailing :line:col (or :line) suffix from a frame location. */
function stripPosition(location: string): string {
  return location.replace(/(?::\d+)+$/, '');
}

/**
 * Parse one line of a rendered stack trace. Non-`at` lines (the message, empty
 * lines) come back with isFrame=false and inApp=true so callers never collapse
 * or de-emphasize them.
 */
export function parseStackFrame(line: string): StackFrame {
  if (!line.trim().startsWith('at ')) {
    return { raw: line, isFrame: false, path: '', inApp: true };
  }
  const match = FRAME_RE.exec(line);
  const path = match ? stripPosition(match[1].trim()) : '';
  return { raw: line, isFrame: true, path, inApp: isInAppFrame(path) };
}
