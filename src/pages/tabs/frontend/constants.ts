import { BulletGraphThreshold } from '../../../components/BulletGraph';

/** Core Web Vitals threshold type — matches Grafana ThresholdStep shape. */
export type VitalThreshold = { value: number; color: string };

/** Key for the five Web Vitals. */
export type VitalKey = 'lcp' | 'fcp' | 'cls' | 'inp' | 'ttfb';

/**
 * CWV thresholds aligned with web.dev definitions and the Alloy pipeline's
 * histogram bucket boundaries. Used for stat panels, table cell coloring,
 * timeseries threshold areas, and the CWV rating breakdown.
 */
export const VITAL_THRESHOLDS: Record<VitalKey, VitalThreshold[]> = {
  lcp: [
    { value: 0, color: 'green' },
    { value: 2500, color: 'orange' },
    { value: 4000, color: 'red' },
  ],
  fcp: [
    { value: 0, color: 'green' },
    { value: 1800, color: 'orange' },
    { value: 3000, color: 'red' },
  ],
  cls: [
    { value: 0, color: 'green' },
    { value: 0.1, color: 'orange' },
    { value: 0.25, color: 'red' },
  ],
  inp: [
    { value: 0, color: 'green' },
    { value: 200, color: 'orange' },
    { value: 500, color: 'red' },
  ],
  ttfb: [
    { value: 0, color: 'green' },
    { value: 800, color: 'orange' },
    { value: 1800, color: 'red' },
  ],
};

/**
 * Histogram bucket boundaries used for CWV rating computation.
 * Maps each vital to [good_le, poor_le] — the `le` values from the Alloy pipeline.
 */
export const CWV_BUCKET_BOUNDARIES: Record<VitalKey, { good: string; poor: string }> = {
  lcp: { good: '2500', poor: '4000' },
  fcp: { good: '1800', poor: '3000' },
  cls: { good: '0.1', poor: '0.25' },
  inp: { good: '200', poor: '500' },
  ttfb: { good: '800', poor: '2000' }, // nearest bucket to 1800ms threshold
};

/** Vital definition for the bullet chart summary. */
export interface VitalDef {
  key: VitalKey;
  label: string;
  description: string;
  tooltip: string;
  unit?: string;
  decimals?: number;
  thresholds: BulletGraphThreshold[];
}

/** Ordered vital definitions — displayed in the page loading sequence. */
export const VITAL_DEFS: VitalDef[] = [
  {
    key: 'ttfb',
    label: 'TTFB',
    description: 'Time to First Byte',
    tooltip: 'Time from request start until the first byte of the response is received. Target < 800 ms.',
    unit: 'ms',
    thresholds: VITAL_THRESHOLDS.ttfb,
  },
  {
    key: 'fcp',
    label: 'FCP',
    description: 'First Contentful Paint',
    tooltip: 'Time until the first text or image is painted. Target < 1800 ms.',
    unit: 'ms',
    thresholds: VITAL_THRESHOLDS.fcp,
  },
  {
    key: 'lcp',
    label: 'LCP',
    description: 'Largest Contentful Paint',
    tooltip: 'Time until the largest text or image element is rendered. Target < 2500 ms.',
    unit: 'ms',
    thresholds: VITAL_THRESHOLDS.lcp,
  },
  {
    key: 'cls',
    label: 'CLS',
    description: 'Cumulative Layout Shift',
    tooltip: 'Total of all unexpected layout shift scores. Target < 0.1.',
    decimals: 2,
    thresholds: VITAL_THRESHOLDS.cls,
  },
  {
    key: 'inp',
    label: 'INP',
    description: 'Interaction to Next Paint',
    tooltip: 'Latency of the slowest interaction during the page visit. Target < 200 ms.',
    unit: 'ms',
    thresholds: VITAL_THRESHOLDS.inp,
  },
];

/**
 * Browser filter for Scenes-interpolated $browser variable.
 * Matches the selected browser or empty string (for SDKs that don't set browser_name).
 */
export const BROWSER_FILTER = `| browser_name=~"$browser|"`;
