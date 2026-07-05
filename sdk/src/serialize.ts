/**
 * Console-argument serialization for the replacement console instrumentation.
 *
 * Guarantees (per nais/grafana-apm-app#66):
 *   - never `[object Object]` and never `{}` for Error values
 *   - depth-limited (default 2), circular-safe
 *   - total output capped (default 2 KB) with an explicit truncation marker
 */

export const DEFAULT_SERIALIZE_DEPTH = 2;
export const DEFAULT_SERIALIZE_MAX_LENGTH = 2048;
const TRUNCATION_MARKER = '…[truncated]';

function serializeValue(value: unknown, depth: number, maxDepth: number, seen: WeakSet<object>): string {
  // Non-JSON values render as plain text at the top level, but must be quoted
  // when nested so the surrounding object/array stays JSON-shaped.
  const asText = (text: string): string => (depth === 0 ? text : JSON.stringify(text));

  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return depth === 0 ? value : JSON.stringify(value);
    case 'number':
    case 'boolean':
      return String(value);
    case 'bigint':
      return asText(`${value}n`);
    case 'undefined':
      return asText('undefined');
    case 'symbol':
      return asText(value.toString());
    case 'function':
      return asText(`[Function${value.name ? `: ${value.name}` : ''}]`);
  }

  // objects (incl. arrays, errors) from here on
  if (value instanceof Error) {
    return asText(`${value.name || 'Error'}: ${value.message}`);
  }
  if (seen.has(value)) {
    return asText('[Circular]');
  }
  if (depth >= maxDepth) {
    return asText(Array.isArray(value) ? '[Array]' : '[Object]');
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeValue(entry, depth + 1, maxDepth, seen)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).map(
    ([key, entry]) => `${JSON.stringify(key)}:${serializeValue(entry, depth + 1, maxDepth, seen)}`
  );
  return `{${entries.join(',')}}`;
}

/** Serialize a single console argument (top-level strings stay unquoted). */
export function serializeConsoleArg(arg: unknown, maxDepth = DEFAULT_SERIALIZE_DEPTH): string {
  try {
    return serializeValue(arg, 0, maxDepth, new WeakSet());
  } catch {
    return '[Unserializable]';
  }
}

/** Serialize console arguments into one space-joined, length-capped message. */
export function serializeConsoleArgs(
  args: unknown[],
  maxDepth = DEFAULT_SERIALIZE_DEPTH,
  maxLength = DEFAULT_SERIALIZE_MAX_LENGTH
): string {
  const message = args.map((arg) => serializeConsoleArg(arg, maxDepth)).join(' ');
  if (message.length > maxLength) {
    return message.slice(0, maxLength) + TRUNCATION_MARKER;
  }
  return message;
}
