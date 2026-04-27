import { ThresholdsMode } from '@grafana/data';
import { SceneQueryRunner, PanelBuilders } from '@grafana/scenes';

import { VitalThreshold } from './constants';

/** Shorthand datasource reference used throughout panel builders. */
export interface DsRef {
  uid: string;
}

/** Build a stat panel with thresholds (used for vitals summary). */
export function buildStatPanel(
  title: string,
  description: string,
  query: SceneQueryRunner,
  unit: string,
  thresholds: VitalThreshold[],
  decimals?: number
) {
  const builder = PanelBuilders.stat().setTitle(title).setDescription(description).setData(query).setUnit(unit);
  if (decimals !== undefined) {
    builder.setDecimals(decimals);
  }
  return builder
    .setOverrides((b) =>
      b.matchFieldsWithName(title).overrideThresholds({
        mode: ThresholdsMode.Absolute,
        steps: thresholds.map((t) => ({ value: t.value, color: t.color })),
      })
    )
    .build();
}

/** Create a Prometheus SceneQueryRunner. */
export function makePromQuery(
  ds: DsRef,
  expr: string,
  legendFormat: string,
  opts?: { minInterval?: string; format?: string; instant?: boolean }
): SceneQueryRunner {
  return new SceneQueryRunner({
    datasource: { uid: ds.uid, type: 'prometheus' },
    ...(opts?.minInterval ? { minInterval: opts.minInterval } : {}),
    queries: [
      {
        refId: 'A',
        expr,
        legendFormat,
        ...(opts?.format ? { format: opts.format } : {}),
        ...(opts?.instant ? { instant: true } : {}),
      },
    ],
  });
}

/** Create a Loki SceneQueryRunner. */
export function makeLokiQuery(
  ds: DsRef,
  expr: string,
  legendFormat: string,
  opts?: { instant?: boolean }
): SceneQueryRunner {
  return new SceneQueryRunner({
    datasource: { uid: ds.uid, type: 'loki' },
    queries: [
      {
        refId: 'A',
        expr,
        legendFormat,
        ...(opts?.instant ? { instant: true } : {}),
      },
    ],
  });
}

/**
 * Normalize page URLs by collapsing UUIDs, long numeric IDs, and stripping query params.
 * Applied via nested label_replace + re-aggregation so multiple raw URLs map to one route pattern.
 */
export function normalizePageUrlExpr(innerExpr: string, label: string): string {
  return `sum by (${label}) (
    label_replace(
      label_replace(
        label_replace(
          ${innerExpr},
          "${label}", "$1", "${label}", "([^?]*)\\\\?.*"
        ),
        "${label}", "\${1}*\${2}", "${label}", "(.*?)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(.*)"
      ),
      "${label}", "\${1}*\${2}", "${label}", "(.*?)/[0-9]{5,}(.*)"
    )
  )`;
}
