/**
 * Baseline-delta computation for the Overview health header (#35).
 *
 * The PRD's proposed "anomaly detection" is deliberately pragmatic: there is
 * no historical baseline storage, so "worse than last period" is the signal.
 * The backend already computes exactly this comparison for the "Attention
 * needed" section (`/health` → prevRate/prevErrorRate/prevP95Duration,
 * see pkg/plugin/health.go's `wrapOffset` — a same-length PromQL `offset`
 * window, floored at 1h). Reusing those numbers here means the header stat
 * row and the attention list below it always agree on "what changed" instead
 * of running a second, independently-windowed PromQL comparison.
 */

export type DeltaPolarity = 'lowerIsBetter' | 'neutral';
export type DeltaDirection = 'increase' | 'decrease' | 'flat';
export type DeltaSeverity = 'good' | 'warn' | 'bad' | 'neutral';

export interface DeltaResult {
  /** Relative change as a fraction (0.2 = +20%), or null when no meaningful baseline exists. */
  pct: number | null;
  direction: DeltaDirection;
  severity: DeltaSeverity;
}

/** Relative changes at or below this magnitude read as "flat" rather than up/down. */
const FLAT_EPSILON = 0.005;
/** >5% relative regression = orange, per the #35 PRD. */
const WARN_THRESHOLD = 0.05;
/** >20% relative regression = red, per the #35 PRD. */
const BAD_THRESHOLD = 0.2;

/**
 * Computes the relative change of `current` vs `previous` and classifies its
 * severity.
 *
 * `polarity` controls whether an increase is judged:
 *  - 'lowerIsBetter' (error rate, P95 latency): an increase is a regression
 *    — 'bad' past a 20% relative rise, 'warn' past 5%, otherwise 'neutral'.
 *    Any decrease is 'good'.
 *  - 'neutral' (request rate): traffic moving up or down is not inherently
 *    good or bad, so severity is always 'neutral' — only direction/magnitude
 *    are reported for display.
 */
export function computeDelta(
  current: number,
  previous: number | undefined | null,
  polarity: DeltaPolarity = 'lowerIsBetter'
): DeltaResult {
  if (previous === undefined || previous === null || !Number.isFinite(previous)) {
    return { pct: null, direction: 'flat', severity: 'neutral' };
  }

  if (previous === 0) {
    if (!current) {
      return { pct: 0, direction: 'flat', severity: 'neutral' };
    }
    // Relative change from zero isn't a meaningful percentage — report the
    // direction without a number, and treat "went from nothing to something"
    // as a regression when polarity cares (e.g. errors appearing).
    return { pct: null, direction: 'increase', severity: polarity === 'neutral' ? 'neutral' : 'bad' };
  }

  const pct = (current - previous) / previous;
  const direction: DeltaDirection = pct > FLAT_EPSILON ? 'increase' : pct < -FLAT_EPSILON ? 'decrease' : 'flat';

  if (polarity === 'neutral') {
    return { pct, direction, severity: 'neutral' };
  }

  if (direction === 'decrease') {
    return { pct, direction, severity: 'good' };
  }
  if (direction === 'flat') {
    return { pct, direction, severity: 'neutral' };
  }

  const abs = Math.abs(pct);
  const severity: DeltaSeverity = abs > BAD_THRESHOLD ? 'bad' : abs > WARN_THRESHOLD ? 'warn' : 'neutral';
  return { pct, direction, severity };
}
