export { VITAL_THRESHOLDS, VITAL_DEFS, CWV_BUCKET_BOUNDARIES } from './constants';
export type { VitalKey, VitalDef, VitalThreshold } from './constants';
export { buildStatPanel, makePromQuery, makeLokiQuery } from './panel-helpers';
export type { DsRef } from './panel-helpers';
export { resolveCapabilities } from './capabilities';
export type { FrontendCapabilities } from './capabilities';
export type { FrontendSceneContext } from './scene-context';
export {
  buildInsightsSection,
  buildTrendsSection,
  buildPerPageSection,
  buildErrorsSection,
  buildSupportSection,
  buildTrafficSection,
} from './sections';
export { WebVitalsBullets } from './components/WebVitalsBullets';
export * from './queries/loki-builders';
export * from './queries/histogram-builders';
