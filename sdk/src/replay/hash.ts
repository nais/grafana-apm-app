/** Tiny dependency-free string hashing shared by throttling and sampling. */

/**
 * djb2 (xor variant) over UTF-16 code units, returned as an unsigned 32-bit
 * integer. Not cryptographic — used only for snapshot throttling keys and
 * deterministic per-session sampling.
 */
export function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return hash >>> 0;
}
