# Design Update: Aligning with Grafana's Official Drilldown App Patterns

> **Date:** 2026-04-19
> **Based on:** Analysis of [logs-drilldown](https://github.com/grafana/logs-drilldown), [traces-drilldown](https://github.com/grafana/traces-drilldown), and [metrics-drilldown](https://github.com/grafana/metrics-drilldown)
> **Compared against:** Current `nais/grafana-otel-plugin` implementation

---

## Executive Summary

Grafana's three official drilldown apps share a remarkably consistent architecture built on the **@grafana/scenes** library. Our plugin uses Scenes only superficially — wrapping individual panels in `EmbeddedScene` — while the core UI is traditional React with manual state, `useState`/`useEffect`, and `react-router-dom` routing. This creates a significant gap in UX consistency, URL shareability, and maintainability.

This document identifies the key architectural patterns from the reference apps, assesses our current gaps, and provides prioritized recommendations for alignment.

---

## 1. Architecture Comparison

### How the Official Apps Are Built

All three drilldown apps follow the same foundational pattern:

```
SceneObjectBase (root scene)
├── $timeRange: SceneTimeRange
├── $variables: SceneVariableSet
│   ├── DataSourceVariable
│   ├── AdHocFiltersVariable (dynamic filters)
│   └── Custom variables (metric selectors, groupBy, etc.)
├── controls: [SceneTimePicker, SceneRefreshPicker]
├── body: SceneFlexLayout
│   ├── Main visualization (VizPanel / PanelBuilders)
│   ├── Secondary panels
│   └── Tab-based action scenes
└── URL sync (UrlSyncContextProvider or SceneApp routing)
```

| Aspect | logs-drilldown | traces-drilldown | metrics-drilldown |
|--------|---------------|------------------|-------------------|
| **Primary framework** | @grafana/scenes ^6.57 | @grafana/scenes ^6.52 | @grafana/scenes ^7.0 |
| **Root scene** | IndexScene (SceneObjectBase) | TraceExploration (SceneObjectBase) | DataTrail (SceneObjectBase) |
| **Routing** | SceneApp drilldowns | React Router + UrlSyncContextProvider | React Router + UrlSyncContextProvider |
| **Variables** | SceneVariableSet with 8+ variables | SceneVariableSet with 6+ variables | SceneVariableSet with 5+ variables |
| **Filters** | AdHocFiltersVariable (labels, fields, metadata) | AdHocFiltersVariable (trace attributes) | AdHocFiltersVariable (label matchers) |
| **Data source** | DataSourceVariable | DataSourceVariable | Custom DataSourceVariable subclass |
| **Panel building** | PanelBuilders fluent API | PanelBuilders + custom configs | PanelBuilders + GmdVizPanel wrapper |
| **State management** | Scene variables + URL sync | Scene variables + event bus | Scene variables + event bus |
| **Cross-panel sync** | behaviors.CursorSync | behaviors.CursorSync | behaviors.CursorSync |

### How Our Plugin Is Built

```
React App (react-router-dom)
├── <Route> ServiceInventory — manual useState, useEffect, fetch
├── <Route> ServiceOverview — manual state + EmbeddedScene per tab
└── <Route> ServiceMap — manual state + EmbeddedScene
```

| Aspect | Our plugin |
|--------|-----------|
| **Primary framework** | React + @grafana/scenes ^6.11 (minimal use) |
| **Root scene** | None — React component tree |
| **Routing** | react-router-dom `<Routes>` |
| **Variables** | None — hardcoded strings in queries |
| **Filters** | None — manual `search` state for text filtering only |
| **Data source** | Hardcoded UIDs: `"mimir"`, `"tempo"`, `"loki"` |
| **Panel building** | PanelBuilders (only in ServiceOverview) |
| **State management** | React useState/useEffect |
| **Cross-panel sync** | None |

---

## 2. Key Gaps

### Gap 1: No Scene-Based Architecture

**What the reference apps do:**
Every component, page, and layout is a Scene object (`SceneObjectBase` subclass). Scenes compose into a tree with automatic lifecycle management, variable propagation, and URL sync.

**What we do:**
Standard React components with lazy loading. Scenes are only used for embedding panels — the app shell, routing, tabs, and data fetching are all manual React code.

**Impact:** We miss out on the entire Scenes ecosystem — automatic variable interpolation in queries, URL state sync, lifecycle management, and consistent interaction patterns with the rest of Grafana.

### Gap 2: Hardcoded Data Source UIDs

**What the reference apps do:**
All three use `DataSourceVariable` (or a subclass) that lets users select their data source at runtime. Queries reference the variable (`${ds}`) rather than a fixed UID.

```typescript
// traces-drilldown
new DataSourceVariable({
  name: VAR_DATASOURCE,
  pluginId: 'tempo',
  value: state.initialDS,
});
```

**What we do:**
Data source UIDs are hardcoded as `"mimir"`, `"tempo"`, and `"loki"` directly in `SceneQueryRunner` configs and explore URL builders.

```typescript
// Our code (ServiceOverview.tsx)
const durationQuery = new SceneQueryRunner({
  datasource: { uid: 'mimir', type: 'prometheus' },
  // ...
});
```

**Impact:** The plugin breaks in any environment where the data sources don't have exactly those UIDs. The configuration page lets users select data sources, but those selections aren't actually used by the frontend.

### Gap 3: No Variable-Driven Filtering

**What the reference apps do:**
All three use `AdHocFiltersVariable` for dynamic filtering. Filter keys and values are populated from the data source at runtime. Filters are encoded in the URL, making every view shareable.

```typescript
// logs-drilldown
new AdHocFiltersVariable({
  name: VAR_LABELS,
  filters: state?.initialLabels ?? [],
  tagKeysProvider: getLabelsTagKeysProvider(),
  tagValuesProvider: getLabelsTagValuesProvider(),
  datasourceUid: EXPLORATION_DS,
});
```

**What we do:**
A text `<Input>` filter on the service inventory page that does client-side string matching. No environment filters, no namespace filters, no ad-hoc label filters. The spec mentions environment filtering and filter chips, but these aren't implemented.

**Impact:** Users can't filter services by `deployment.environment`, can't build shareable filtered views, and can't do any dynamic label-based filtering.

### Gap 4: No URL State Synchronization

**What the reference apps do:**
All three persist view state in the URL — active tab, filters, time range, selected metric, sort order, etc. This is done via `UrlSyncContextProvider` or `SceneObjectUrlSyncConfig`. Every view is a shareable link.

```typescript
// metrics-drilldown
protected _urlSync = new SceneObjectUrlSyncConfig(this, {
  keys: ['metric'],
});
```

**What we do:**
URL only contains the route path (`/services/:namespace/:service`). Active tab, sort order, search text, percentile selection — all lost on page reload or link share.

**Impact:** Users can't share a link to "the errors tab of service X showing P99 latency" — they always land on the overview tab with default settings.

### Gap 5: Navigation Uses Full Page Reloads

**What the reference apps do:**
Navigation uses Grafana's `locationService` or scene-based URL changes. State transitions are smooth without full reloads.

**What we do:**
```typescript
// ServiceInventory.tsx
onClick={() => {
  window.location.href = `${PLUGIN_BASE_URL}/services/...`;
}}
```

**Impact:** Every navigation causes a full page reload, losing all in-memory state and causing a flash of loading.

### Gap 6: No Cursor Sync Across Panels

**What the reference apps do:**
All three use `behaviors.CursorSync` to synchronize crosshairs across related panels. Hovering over the Duration panel highlights the same time point on Rate and Errors panels.

```typescript
// metrics-drilldown
new SceneFlexLayout({
  $behaviors: [new behaviors.CursorSync({ key: 'metricCrosshairSync' })],
  children: [/* panels */],
})
```

**What we do:**
The three RED panels in ServiceOverview are independent `SceneFlexItem` children without any cursor sync behavior.

**Impact:** When investigating a spike, users can't visually correlate Duration, Errors, and Rate at the same timestamp by hovering.

### Gap 7: Missing Event Bus / Custom Events

**What the reference apps do:**
Both traces-drilldown and metrics-drilldown use scene events (`BusEventWithPayload`) for decoupled communication — trace opened, metric selected, filter changed, etc.

```typescript
// traces-drilldown
export class EventTraceOpened extends BusEventWithPayload<EventTraceOpenedPayload> {
  public static type = 'trace-opened';
}
```

**What we do:**
Direct function calls and prop drilling. No event system for cross-component communication.

### Gap 8: No Custom Scene Objects

**What the reference apps do:**
Each app defines 10-40+ custom `SceneObjectBase` subclasses for specific UI behaviors — breakdown scenes, filter scenes, toolbar scenes, panel scenes, etc. These encapsulate both behavior and rendering.

**What we do:**
All behavior lives in React function components with hooks. The only "scene" code is constructing `EmbeddedScene` objects inside `useMemo`.

---

## 3. Pattern Catalog from Reference Apps

### Pattern A: Scene-as-Page

Every major view is a SceneObjectBase subclass with its own state, lifecycle, URL sync, and variables.

```typescript
// Pattern from all three apps
export class ServiceOverviewScene extends SceneObjectBase<ServiceOverviewState> {
  protected _urlSync = new SceneObjectUrlSyncConfig(this, { keys: ['tab', 'percentile'] });

  constructor(state: Partial<ServiceOverviewState>) {
    super({
      $timeRange: new SceneTimeRange({ from: 'now-1h', to: 'now' }),
      $variables: new SceneVariableSet({ variables: [...] }),
      controls: [new SceneTimePicker({}), new SceneRefreshPicker({})],
      body: new SceneFlexLayout({ children: [...] }),
      ...state,
    });
  }
}
```

### Pattern B: DataSourceVariable with Fallback

Data source selection flows through a variable, not hardcoded UIDs.

```typescript
// Pattern from metrics-drilldown
const ds = new DataSourceVariable({
  name: 'ds',
  pluginId: 'prometheus',
  value: initialDS ?? getDefaultFromStorage() ?? getDefaultFromConfig(),
});

// Queries reference the variable
const query = new SceneQueryRunner({
  datasource: { uid: '${ds}', type: 'prometheus' },
  queries: [{ refId: 'A', expr: '...' }],
});
```

### Pattern C: AdHocFiltersVariable for Dynamic Filtering

Dynamic filters with provider functions for key/value suggestions.

```typescript
// Pattern from logs-drilldown / traces-drilldown
new AdHocFiltersVariable({
  name: 'filters',
  layout: 'combobox',
  filters: initialFilters,
  allowCustomValue: true,
  expressionBuilder: renderFilterExpression,
  getTagKeysProvider: async () => {
    const keys = await datasource.getTagKeys();
    return { replace: true, values: keys };
  },
  getTagValuesProvider: async (_, filter) => {
    const values = await datasource.getTagValues(filter.key);
    return { replace: true, values: values };
  },
});
```

### Pattern D: UrlSyncContextProvider

The app wraps its root scene in a URL sync provider for automatic state persistence.

```typescript
// Pattern from traces-drilldown / metrics-drilldown
<UrlSyncContextProvider
  scene={rootScene}
  createBrowserHistorySteps={true}
  updateUrlOnInit={true}
>
  <rootScene.Component model={rootScene} />
</UrlSyncContextProvider>
```

### Pattern E: PanelBuilders with Behaviors and Header Actions

Panels are built with the fluent API and decorated with behaviors and actions.

```typescript
// Pattern from metrics-drilldown
PanelBuilders.timeseries()
  .setTitle('Duration')
  .setData(queryRunner)
  .setUnit('ms')
  .setCustomFieldConfig('fillOpacity', 9)
  .setBehaviors([cursorSync, extremeValueFilter])
  .setHeaderActions([
    new ExploreAction({ datasource }),
    new AddToDashboardAction(),
  ])
  .setOverrides((b) => {
    b.matchFieldsByQuery('A').overrideColor({ mode: 'fixed', fixedColor: 'blue' });
  })
  .build();
```

### Pattern F: Event-Driven Communication

Scene events for decoupled cross-component messaging.

```typescript
// Pattern from traces-drilldown
class EventTraceOpened extends BusEventWithPayload<{ traceId: string }> {
  static type = 'trace-opened';
}

// Publishing
this.publishEvent(new EventTraceOpened({ traceId }), true);

// Subscribing
this._subs.add(
  this.subscribeToEvent(EventTraceOpened, (event) => {
    this.setState({ traceId: event.payload.traceId });
  })
);
```

### Pattern G: Breakdown/Drilldown Scenes

Tab-based views that show different aspects of the data, each as its own scene.

```typescript
// Pattern from all three apps
const actionViews = [
  { value: 'overview', getScene: () => new OverviewScene({}) },
  { value: 'breakdown', getScene: () => new LabelBreakdownScene({}) },
  { value: 'traces', getScene: () => new TracesListScene({}) },
  { value: 'logs', getScene: () => new LogsScene({}) },
];

// Active tab stored in URL via _urlSync
setActionView(type: string) {
  const def = actionViews.find(v => v.value === type);
  this.setState({ activeTab: def.getScene() });
}
```

### Pattern H: Cursor Sync Behavior

Cross-panel crosshair synchronization for correlated panels.

```typescript
// Pattern from all three apps
new SceneFlexLayout({
  $behaviors: [
    new behaviors.CursorSync({
      key: 'red-panel-sync',
      sync: DashboardCursorSync.Crosshair,
    }),
  ],
  children: [durationPanel, errorsPanel, ratePanel],
})
```

---

## 4. Prioritized Recommendations

### Priority 1: Replace Hardcoded Data Source UIDs (High impact, low effort)

**Why:** The plugin is currently broken for any environment where data sources aren't named exactly "mimir", "tempo", "loki". This is the most critical functional issue.

**How:**
1. Create a `DataSourceVariable` for each signal (metrics, traces, logs)
2. Initialize from the plugin's configuration settings (already stored via AppConfig)
3. Reference `${dsMetrics}`, `${dsTraces}`, `${dsLogs}` in all queries
4. Update explore URL builders to accept variable-resolved UIDs

### Priority 2: Adopt Scene-Based Root Architecture (High impact, high effort)

**Why:** This is the foundation that unlocks all other improvements — URL sync, variable propagation, lifecycle management, cursor sync. Without this, other patterns can't be adopted cleanly.

**How:**
1. Create a root `AppObservabilityScene` extending `SceneObjectBase`
2. Set up `SceneVariableSet` with data source variables, time range, and environment filter
3. Wrap in `UrlSyncContextProvider`
4. Create `ServiceInventoryScene`, `ServiceOverviewScene`, `ServiceMapScene` as child scenes
5. Replace react-router `<Routes>` with scene-based navigation (either `SceneApp` drilldowns or URL-synced scene swapping like metrics-drilldown)

**Migration path:** This can be done page-by-page. Start with `ServiceOverview` since it already uses Scenes heavily, then migrate `ServiceInventory` and `ServiceMap`.

### Priority 3: Add Environment and Namespace Filtering (High impact, medium effort)

**Why:** The spec explicitly requires environment filtering with removable filter chips and a "+ Filter" button. This is a missing feature, and the reference apps show exactly how to implement it.

**How:**
1. Add an `AdHocFiltersVariable` for environment/namespace filters
2. Use `getTagKeysProvider` to query available label keys from Mimir
3. Use `getTagValuesProvider` to query available values
4. Filters automatically interpolate into PromQL queries via `${filters}`
5. Filters persist in URL for shareability

### Priority 4: Add URL State Persistence (Medium impact, comes free with Priority 2)

**Why:** Users can't share links to specific views. Every page reload loses tab selection, sort order, and percentile choice.

**How:** Automatically handled by `UrlSyncContextProvider` once scenes are adopted. Each scene declares its URL keys:
```typescript
protected _urlSync = new SceneObjectUrlSyncConfig(this, {
  keys: ['tab', 'percentile', 'sortField', 'sortDir'],
});
```

### Priority 5: Add Cursor Sync Across RED Panels (Low effort, medium impact)

**Why:** The three RED panels (Duration, Errors, Rate) are the primary investigation surface. Cursor sync enables visual correlation across signals.

**How:** Wrap the three `SceneFlexItem` children in a `SceneFlexLayout` with a `CursorSync` behavior. This is a one-line addition once the scene architecture is in place.

### Priority 6: Fix Navigation to Avoid Full Reloads (Low effort, high UX impact)

**Why:** `window.location.href` causes full page reloads, which is jarring and loses state.

**How:** Replace with `locationService.push()` from `@grafana/runtime`, or with scene-based navigation.

```typescript
// Before
window.location.href = `${PLUGIN_BASE_URL}/services/${ns}/${name}`;

// After
import { locationService } from '@grafana/runtime';
locationService.push(`${PLUGIN_BASE_URL}/services/${ns}/${name}`);
```

### Priority 7: Upgrade @grafana/scenes (Low effort, enables features)

**Why:** We're on `@grafana/scenes` ~6.11. The reference apps use 6.52–7.0, which include improved `AdHocFiltersVariable`, `UrlSyncContextProvider` with `namespace` support, and `PanelBuilders` improvements.

**How:** Update `package.json` to `@grafana/scenes: "^6.52.0"` (or ^7.0 if targeting Grafana 13+). Test for breaking changes.

---

## 5. Proposed Architecture (Post-Migration)

```
AppObservabilityScene (SceneObjectBase)
├── $timeRange: SceneTimeRange
├── $variables: SceneVariableSet
│   ├── DataSourceVariable (dsMetrics — Mimir/Prometheus)
│   ├── DataSourceVariable (dsTraces — Tempo)
│   ├── DataSourceVariable (dsLogs — Loki)
│   ├── AdHocFiltersVariable (env/namespace/custom filters)
│   └── CustomVariable (selected service, if any)
├── controls: [SceneTimePicker, SceneRefreshPicker, VariableValueSelectors]
│
├── UrlSyncContextProvider
│
├── topScene: (switches based on URL state)
│   ├── ServiceInventoryScene
│   │   ├── $data: SceneQueryRunner (services query via backend)
│   │   ├── body: Custom table scene with sort/filter/pagination
│   │   └── _urlSync: keys ['search', 'sort', 'page']
│   │
│   ├── ServiceOverviewScene
│   │   ├── $variables: SceneVariableSet
│   │   │   └── CustomVariable (percentile, activeTab)
│   │   ├── header: ServiceHeaderScene (title, SDK badge, links)
│   │   ├── tabs: TabsScene (overview | traces | logs | service-map)
│   │   ├── body: SceneFlexLayout
│   │   │   ├── $behaviors: [CursorSync]
│   │   │   ├── DurationPanel (PanelBuilders.timeseries)
│   │   │   ├── ErrorsPanel (PanelBuilders.timeseries)
│   │   │   └── RatePanel (PanelBuilders.timeseries)
│   │   ├── operationsScene: OperationsTableScene
│   │   └── _urlSync: keys ['tab', 'percentile']
│   │
│   └── ServiceMapScene
│       ├── $data: SceneDataNode (node graph frames)
│       ├── body: VizPanel (nodeGraph)
│       └── _urlSync: keys ['focusService']
```

---

## 6. Implementation Roadmap

### Phase 1: Quick Wins (no architecture change)
- [ ] Replace hardcoded data source UIDs with config-resolved values
- [ ] Replace `window.location.href` with `locationService.push()`
- [ ] Add `CursorSync` behavior to the RED panels `SceneFlexLayout`
- [ ] Upgrade `@grafana/scenes` to ^6.52+

### Phase 2: Scene Foundation
- [ ] Create root `AppObservabilityScene` with `SceneVariableSet`
- [ ] Implement `DataSourceVariable` for metrics, traces, logs
- [ ] Wrap app in `UrlSyncContextProvider`
- [ ] Migrate `ServiceOverview` to a `SceneObjectBase` subclass

### Phase 3: Full Scene Migration
- [ ] Migrate `ServiceInventory` to scene-based architecture
- [ ] Migrate `ServiceMap` to scene-based architecture
- [ ] Add `AdHocFiltersVariable` for environment/namespace filtering
- [ ] Implement URL state persistence for all views

### Phase 4: Advanced Patterns
- [ ] Add event bus for cross-scene communication (trace opened, service selected)
- [ ] Implement drilldown navigation (service inventory → service overview → operation detail)
- [ ] Add panel header actions (Explore, Add to Dashboard)
- [ ] Consider exposed components for embedding in other plugins

---

## 7. Version Compatibility Notes

| Package | Our version | Reference range | Recommendation |
|---------|-------------|-----------------|----------------|
| `@grafana/scenes` | ~6.11.0 | 6.52–7.0 | Upgrade to ^6.52.0 minimum |
| `@grafana/data` | 12.4.2 | 12.3–13.0 | Current version is fine |
| `@grafana/runtime` | 12.4.2 | 12.3–12.4 | Current version is fine |
| `@grafana/ui` | 12.4.2 | 12.3–12.4 | Current version is fine |
| `react-router-dom` | ^6.22.0 | 6.30–7.12 | Keep for transition, remove after full scene migration |

---

## 8. Key Takeaways

1. **Scenes is not optional** — all three reference apps are built scene-first. Using Scenes only for panel embedding misses the core value proposition.

2. **Variables are the state layer** — `SceneVariableSet` replaces React state for anything that should persist in the URL or propagate to child scenes.

3. **AdHocFiltersVariable is the filter pattern** — don't build custom filter UIs. Use the built-in variable with tag providers.

4. **DataSourceVariable is mandatory** — hardcoding UIDs is a deployment blocker.

5. **URL sync is free** — once you're on Scenes, `UrlSyncContextProvider` gives you shareable links, browser back/forward, and state persistence with zero custom code.

6. **CursorSync is a one-liner** — adding `behaviors.CursorSync` to a layout instantly improves the investigation experience across correlated panels.

7. **The reference apps don't use SceneApp consistently** — metrics-drilldown and traces-drilldown use React Router + `UrlSyncContextProvider`, while logs-drilldown uses `SceneApp` with drilldowns. Either approach works; the key is using Scenes for state and URL sync regardless of routing strategy.
