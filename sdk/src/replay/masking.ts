/**
 * The NON-OVERRIDABLE privacy floor for all replay capture
 * (nais/grafana-apm-app#58, #67).
 *
 * Everything is masked at serialization time, in the browser, before any byte
 * leaves the user's machine:
 *   - every input value is masked (`maskAllInputs`, no exceptions — inputs can
 *     never be unmasked, not even with `data-apm-unmask`),
 *   - all text is masked (`maskTextSelector: '*'`) except elements inside an
 *     explicit `data-apm-unmask` allowlist attribute,
 *   - media, canvas, iframes, embeds and `[data-apm-block]` are always blocked,
 *   - images and stylesheets are never inlined.
 *
 * There is deliberately no options path to weaken any of this: the builders
 * only accept extra `block` selectors (privacy can only be tightened) and the
 * returned option fragments are deep-frozen — mutation throws in strict mode.
 */

export const UNMASK_ATTRIBUTE = 'data-apm-unmask';
export const BLOCK_ATTRIBUTE = 'data-apm-block';

const UNMASK_SELECTOR = `[${UNMASK_ATTRIBUTE}]`;

/** Always-blocked elements. Apps can add selectors; these can never be removed. */
const BASE_BLOCK_SELECTORS: readonly string[] = [
  'img',
  'picture',
  'svg image',
  'video',
  'audio',
  'canvas',
  'iframe',
  'embed',
  'object',
  `[${BLOCK_ATTRIBUTE}]`,
];

/** Compose the base block list with app-supplied extra selectors (tighten-only). */
export function buildBlockSelector(extraBlock?: readonly string[]): string {
  const extras = (extraBlock ?? [])
    .map((selector) => (typeof selector === 'string' ? selector.trim() : ''))
    .filter((selector) => selector.length > 0);
  return [...BASE_BLOCK_SELECTORS, ...extras].join(',');
}

/** Replace every non-whitespace character with `*`, preserving layout/word shape. */
function maskCharacters(text: string): string {
  return text.replace(/\S/g, '*');
}

/**
 * rrweb `maskTextFn`: masks all text unless the owning element carries (or is
 * inside an element carrying) the `data-apm-unmask` allowlist attribute.
 */
export function maskText(text: string, element: HTMLElement | null): string {
  try {
    if (element && typeof element.closest === 'function' && element.closest(UNMASK_SELECTOR) !== null) {
      return text;
    }
  } catch {
    // Any DOM weirdness falls through to masking — fail closed.
  }
  return maskCharacters(text);
}

/** Masking fragment for `rrweb.record()`. Frozen: attempts to override throw. */
export interface RecordMaskingOptions {
  readonly maskAllInputs: true;
  readonly maskTextSelector: '*';
  readonly maskTextFn: typeof maskText;
  readonly blockSelector: string;
  readonly inlineStylesheet: false;
  readonly inlineImages: false;
  readonly recordCanvas: false;
  readonly collectFonts: false;
  readonly slimDOMOptions: true;
}

/** Masking fragment for `rrweb-snapshot`'s `snapshot()`. Frozen. */
export interface SnapshotMaskingOptions {
  readonly maskAllInputs: true;
  readonly maskTextSelector: '*';
  readonly maskTextFn: typeof maskText;
  readonly blockSelector: string;
  readonly inlineStylesheet: false;
  readonly inlineImages: false;
  readonly recordCanvas: false;
  readonly slimDOM: true;
}

/**
 * Build the record-time masking floor. `extraBlock` selectors are appended to
 * the base block list; nothing can be relaxed. Spread this LAST into rrweb
 * `record()` options so it always wins.
 */
export function buildRecordMaskingOptions(extraBlock?: readonly string[]): RecordMaskingOptions {
  return Object.freeze({
    maskAllInputs: true,
    maskTextSelector: '*',
    maskTextFn: maskText,
    blockSelector: buildBlockSelector(extraBlock),
    inlineStylesheet: false,
    inlineImages: false,
    recordCanvas: false,
    collectFonts: false,
    slimDOMOptions: true,
  } as const);
}

/** Build the snapshot-time masking floor (same rules, snapshot option names). */
export function buildSnapshotMaskingOptions(extraBlock?: readonly string[]): SnapshotMaskingOptions {
  return Object.freeze({
    maskAllInputs: true,
    maskTextSelector: '*',
    maskTextFn: maskText,
    blockSelector: buildBlockSelector(extraBlock),
    inlineStylesheet: false,
    inlineImages: false,
    recordCanvas: false,
    slimDOM: true,
  } as const);
}
