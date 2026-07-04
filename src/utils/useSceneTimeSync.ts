import { useEffect, useRef } from 'react';
import type { EmbeddedScene } from '@grafana/scenes';

/**
 * Keeps an EmbeddedScene's $timeRange following the shared URL time range now
 * that the global header owns the time picker (there is no SceneTimePicker in
 * the scene controls anymore).
 *
 * Scenes are rebuilt (a fresh useMemo identity, keyed remount) whenever the
 * from/to *strings* change — an absolute pick, or now-1h → now-3h — so those
 * changes already propagate through the rebuild. The one case a rebuild misses
 * is a refresh of a RELATIVE range: the strings stay 'now-1h'/'now' while the
 * module-shared refresh tick (utils/timeRange) re-resolves them to fresh
 * fromMs/toMs. Adding fromMs/toMs to the scene's memo deps would recreate the
 * whole EmbeddedScene on every tick and flash the panels (the deliberate
 * reason those memos key on the raw strings, not the resolved ms). Instead we
 * re-resolve the existing scene's time range in place via onRefresh(), which
 * re-queries without tearing the panels down.
 */
export function useSceneTimeSync(scene: EmbeddedScene | null, fromMs: number, toMs: number): void {
  const sceneRef = useRef(scene);
  const msRef = useRef({ fromMs, toMs });

  useEffect(() => {
    if (!scene) {
      return;
    }
    // A rebuilt scene already resolved the current window on activation — adopt
    // it without firing an extra refresh (which would double-query on mount).
    if (sceneRef.current !== scene) {
      sceneRef.current = scene;
      msRef.current = { fromMs, toMs };
      return;
    }
    if (msRef.current.fromMs === fromMs && msRef.current.toMs === toMs) {
      return;
    }
    msRef.current = { fromMs, toMs };
    scene.state.$timeRange?.onRefresh();
  }, [scene, fromMs, toMs]);
}
