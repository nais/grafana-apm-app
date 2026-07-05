/**
 * Web-vitals attribution section (M2 gap quick win).
 *
 * Faro Web SDK v2 always ships web-vitals attribution with the measurement
 * payload. In Loki these land as logfmt context fields on kind="measurement"
 * lines (verified against @grafana/faro-web-sdk 2.8.2
 * instrumentations/webVitals/webVitalsWithAttribution.ts):
 *   LCP → context_element (the DOM element that was the largest paint)
 *   INP → context_interaction_target (the element the user interacted with)
 *   CLS → context_largest_shift_target (the element that shifted the most)
 *
 * This section renders a row of three tables — one per vital — each listing
 * the top attribution targets weighted by average vital value and sample count.
 */
import { SceneFlexLayout, SceneFlexItem, SceneQueryRunner, SceneDataTransformer, PanelBuilders } from '@grafana/scenes';
import { ThresholdsMode } from '@grafana/schema';

import { otel } from '../../../otelconfig';
import { VITAL_THRESHOLDS, type VitalKey } from './constants';
import {
  lokiVitalAttributionAvgExpr,
  lokiVitalAttributionCountExpr,
  type LokiClusterOpts,
} from './queries/loki-builders';
import { FrontendSceneContext } from './scene-context';

/** Derive LokiClusterOpts from scene context (undefined when no filter needed). */
function clusterOpts(ctx: FrontendSceneContext): LokiClusterOpts | undefined {
  return ctx.clusterFilter ? { cluster: ctx.clusterFilter, clusterLabel: ctx.clusterLabel } : undefined;
}

interface AttributionPanelDef {
  /** Vital logfmt field (also keys VITAL_THRESHOLDS). */
  vital: VitalKey;
  /** Attribution context field to group by. */
  attrField: string;
  title: string;
  description: string;
  /** Display name for the attribution column. */
  attrColumn: string;
  /** Display name for the average-value column. */
  avgColumn: string;
  /** Grafana unit for the average-value column. */
  unit: string;
  /** Decimals for the average-value column. */
  decimals: number;
}

const ATTRIBUTION_PANELS: AttributionPanelDef[] = [
  {
    vital: 'lcp',
    attrField: otel.faroLoki.lcpElement,
    title: 'Slowest LCP Elements',
    description: 'DOM elements responsible for the Largest Contentful Paint, ranked by average LCP',
    attrColumn: 'Element',
    avgColumn: 'Avg LCP (ms)',
    unit: 'ms',
    decimals: 0,
  },
  {
    vital: 'inp',
    attrField: otel.faroLoki.inpInteractionTarget,
    title: 'Slowest Interactions (INP)',
    description: 'Elements users interacted with, ranked by average Interaction to Next Paint',
    attrColumn: 'Interaction Target',
    avgColumn: 'Avg INP (ms)',
    unit: 'ms',
    decimals: 0,
  },
  {
    vital: 'cls',
    attrField: otel.faroLoki.clsShiftTarget,
    title: 'Layout Shift Sources (CLS)',
    description: 'Elements that caused the largest layout shifts, ranked by average CLS',
    attrColumn: 'Shift Source',
    avgColumn: 'Avg CLS',
    unit: 'none',
    decimals: 3,
  },
];

/** Build one attribution table panel (avg value + sample count per target). */
function buildAttributionPanel(ctx: FrontendSceneContext, def: AttributionPanelDef): SceneFlexItem {
  const co = clusterOpts(ctx);

  const query = new SceneQueryRunner({
    datasource: { uid: ctx.logsDs.uid, type: 'loki' },
    queries: [
      {
        refId: 'avg',
        expr: lokiVitalAttributionAvgExpr(ctx.service, def.vital, def.attrField, '[$__range]', undefined, co),
        legendFormat: '__auto',
        format: 'table',
        instant: true,
      },
      {
        refId: 'count',
        expr: lokiVitalAttributionCountExpr(ctx.service, def.vital, def.attrField, '[$__range]', undefined, co),
        legendFormat: '__auto',
        format: 'table',
        instant: true,
      },
    ],
  });

  const data = new SceneDataTransformer({
    $data: query,
    transformations: [
      { id: 'merge', options: {} },
      {
        id: 'organize',
        options: {
          excludeByName: { Time: true },
        },
      },
      { id: 'sortBy', options: { sort: [{ field: 'Value #avg', desc: true }] } },
    ],
  });

  return new SceneFlexItem({
    minHeight: 280,
    body: PanelBuilders.table()
      .setTitle(def.title)
      .setDescription(def.description)
      .setData(data)
      .setOverrides((b) => {
        b.matchFieldsWithName(def.attrField).overrideDisplayName(def.attrColumn);
        b.matchFieldsWithName('Value #avg')
          .overrideDisplayName(def.avgColumn)
          .overrideUnit(def.unit)
          .overrideThresholds({ mode: ThresholdsMode.Absolute, steps: VITAL_THRESHOLDS[def.vital] })
          .overrideCustomFieldConfig('cellOptions', { type: 'color-background' as any })
          .overrideDecimals(def.decimals);
        b.matchFieldsWithName('Value #count').overrideDisplayName('Samples').overrideDecimals(0);
      })
      .build(),
  });
}

/**
 * Web-vitals attribution row: Slowest LCP Elements, Slowest Interactions (INP),
 * Layout Shift Sources (CLS). Requires Loki (attribution rides on measurement
 * logs only) — returns null when Loki has no data for the service.
 */
export function buildAttributionSection(ctx: FrontendSceneContext): SceneFlexLayout | null {
  if (!ctx.hasLoki) {
    return null;
  }

  return new SceneFlexLayout({
    direction: 'row',
    children: ATTRIBUTION_PANELS.map((def) => buildAttributionPanel(ctx, def)),
  });
}
