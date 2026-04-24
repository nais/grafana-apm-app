# Visualization Guide

Guidelines for choosing and using visualizations consistently across the
Nais APM plugin. Each visualization type has a specific purpose — use the
decision table below to pick the right one for your data.

For the _why_ behind these choices — observability strategy, cognitive load
principles, and visual design rules — see [design-philosophy.md](design-philosophy.md).

---

## Decision Table

| Data shape | User question | Visualization | Example |
|---|---|---|---|
| Single metric, universal thresholds | "Is this value good or bad?" | **Bullet graph** | Core Web Vital (LCP, CLS, FID) |
| Single metric, no universal threshold | "What's the current value?" | **Stat box** | Service count, total rate |
| Single metric + trend | "How is this trending?" | **Stat box + sparkline** | Aggregate namespace rate |
| Count vs total | "How many are in this state?" | **Stat box (X of Y)** | "With Errors: 1 of 12" |
| Time series, one metric | "How does this change over time?" | **Line/area panel** (Scenes) | Error rate over time |
| Time series, per-service breakdown | "Which service contributes most?" | **Stacked area** (Scenes) | Rate by service |
| Compact inline trend | "Is this going up or down?" | **Sparkline** | Table row trend column |
| Service status at a glance | "Is this service healthy?" | **Health dot** (🟢🟡🔴) | Services table, topology |
| Ranked list of problems | "What needs my attention?" | **Attention list** | NeedsAttention section |
| Change vs previous period | "Is this new or ongoing?" | **Delta arrow** (↑↓→) | Error rate change |
| Network of dependencies | "How do services connect?" | **Topology graph** | Service map |
| Tabular data with sorting | "Compare services side by side" | **Sortable table** | Services table, dependencies |
| Latency distribution | "What does the latency shape look like?" | **Heatmap** (Scenes) | Duration heatmap on Operations tab |

---

## Visualization Components

### Bullet Graph (`BulletGraph.tsx`)

A compact card showing a measured value against qualitative ranges (Stephen
Few design). Three colored bands represent "good", "needs improvement", and
"poor" zones, with a marker showing the current value.

**When to use:**
- The metric has well-defined, universal thresholds that apply regardless of
  context (e.g., Google's Core Web Vitals).
- You want users to instantly judge "is this good or bad?" without needing
  to learn what the number means.

**When NOT to use:**
- Thresholds are context-dependent (e.g., P95 latency varies by service type).
- The metric is an aggregate across heterogeneous services (thresholds for
  the aggregate are meaningless).
- The value range is unbounded or varies wildly (bullet graph needs a
  predictable scale).

**API:**
```tsx
<BulletGraph
  label="LCP"
  description="Largest Contentful Paint"
  value={2100}
  thresholds={[
    { value: 0,    color: 'green' },
    { value: 2500, color: 'orange' },
    { value: 4000, color: 'red' },
  ]}
  unit="ms"
  tooltip="Time until the largest content element is rendered"
/>
```

**Threshold format:** Ordered array of `{ value, color }`. The first entry
is the start of the "good" zone, the second starts "needs improvement", and
the third starts "poor". Colors reference Grafana visualization palette names.

**Current usage:** Frontend tab — Core Web Vitals (LCP, FID, CLS, TTFB, INP).

---

### Sparkline (`Sparkline.tsx`)

A tiny inline SVG area chart. No axes, no labels — just the shape of the
trend. Renders as a pure SVG with no dependencies.

**When to use:**
- Showing directional trend in a compact space (table cells, stat boxes).
- You want to convey "going up/down/flat" without exact values.

**When NOT to use:**
- Users need to read exact values from the chart.
- The data needs axes, legends, or interactive tooltips.

**API:**
```tsx
<Sparkline
  data={[1.2, 1.5, 1.3, 1.8, 2.1]}
  color="#73BF69"
  width={100}
  height={20}
/>
```

**Current usage:** Services table (rate + duration trend), namespace stats
(aggregate rate sparkline).

---

### Health Dot (🟢🟡🔴)

A colored emoji indicator showing health classification at a glance. Based
on `getServiceHealth()` or `getDependencyHealth()` from `utils/health.ts`.

**When to use:**
- Summarizing overall health of a service or dependency in a table row,
  card, or topology node.
- Space is limited and a single color communicates enough.

**When NOT to use:**
- You need to show _why_ something is unhealthy (use the attention list
  or detail view instead).

**Service thresholds** (error rate as percentage):
| Status | Condition |
|--------|-----------|
| 🟢 Healthy | Error rate ≤ 1% AND P95 ≤ 5s |
| 🟡 Warning | Error rate 1–5% OR P95 > 5s |
| 🔴 Critical | Error rate > 5% |

**Dependency thresholds** (error rate as fraction 0–1):
| Status | Condition |
|--------|-----------|
| 🟢 Healthy | Error rate ≤ 1% |
| 🟡 Warning | Error rate 1–5% |
| 🔴 Critical | Error rate > 5% |

**Current usage:** Services table, dependencies table, NeedsAttention section.
Topology nodes use a similar approach via border coloring (error-rate only).

---

### Delta Arrow (↑↓→)

A single character showing whether a metric increased, decreased, or stayed
stable compared to the previous period. Calculated by `deltaArrow()` from
`utils/health.ts`.

**When to use:**
- Users need to know "did this just happen?" at a glance.
- You have previous-period comparison data available.

**When NOT to use:**
- Time range is absolute (no meaningful "previous period").
- Previous data fetch failed — show nothing instead of a misleading arrow.

**Semantics:** A 5% relative change threshold prevents noise from causing
false ↑/↓ signals on stable values.

**Current usage:** NeedsAttention section (error rate, P95), services table
(error rate, P95 columns).

---

### Stat Box (`NamespaceStats.tsx`)

A simple card showing a large value with a title. Can optionally include a
sparkline, color coding, and a change delta.

**When to use:**
- Showing a single headline number for a page section.
- The metric makes sense as a standalone number without thresholds.

**Design guidelines:**
- Use "X of Y" format for counts that need context (e.g., "1 of 12" not "1").
- Use color only when there's a clear good/bad interpretation
  (green = all healthy, red = services have errors).
- Prefer counts over percentages for aggregates — "1 of 12 with errors"
  is clearer than "0.4% weighted error rate".

**Current usage:** Namespace page — services count, rate, with-errors, healthy.

---

### Attention List (`NeedsAttention.tsx`)

A ranked list of services that need attention, sorted by severity (critical
first) then impact (rate × error rate). Each item shows health dot, service
name, key metrics with delta arrows, and an error sparkline.

**When to use:**
- The page shows many services and users need to quickly find problems.
- You want to answer "do I need to act?" without scanning a table.

**Design guidelines:**
- Limit to top 5 items to avoid becoming a second table.
- Hide the section entirely when everything is healthy.
- Sort by severity first, then by impact — a high-traffic warning matters
  more than a low-traffic warning.

**Current usage:** Namespace page — between stats and topology.

---

### Scene Panels (Grafana Scenes)

Standard Grafana panels (timeseries, stat, heatmap, logs, table) rendered
via `@grafana/scenes` with `SceneQueryRunner` and `PanelBuilders`. These
get native Grafana features: time picker, refresh picker, panel inspect,
drill-down.

**When to use:**
- Showing PromQL/LogQL/TraceQL query results on service detail pages.
- Users need interactive features (zoom, hover, inspect, download).
- The visualization maps directly to a Grafana panel type.

**When NOT to use:**
- Team/namespace overview pages where you need custom layouts.
- Inline indicators in tables or cards.

**Current usage:** Operations tab (RED panels, heatmap), Frontend tab (web
vitals, Loki panels), Traces tab, Logs tab.

---

## Page-Level Guidelines

### Namespace / Team Page

Focus on **"do I need to act?"** — use health dots, attention lists, and
counts. Avoid detailed charts that are better suited to service detail pages.

| Section | Visualizations used |
|---------|-------------------|
| Stats | Stat boxes (count, rate + sparkline, X-of-Y counts) |
| Needs Attention | Attention list (health dot, metrics, delta arrows, sparkline) |
| Topology | Graph with error-rate border coloring |
| Services table | Health dots, delta arrows, sparklines |
| Dependencies | Health dots |

### Service Detail Page

Focus on **"what's happening and why?"** — use Scene panels for
interactive exploration with full Grafana features.

| Tab | Visualizations used |
|-----|-------------------|
| Operations | Timeseries (RED metrics), heatmap (latency distribution) |
| Frontend | Bullet graphs (Web Vitals), Scene stat + timeseries panels |
| Traces | Scene table (trace list) |
| Logs | Scene logs panel + volume timeseries |
| Runtime | Stat boxes (JVM/Node.js/Go metrics) |
| Dependencies | Table with sparklines |

### Service Inventory (Top-Level)

Focus on **"find the service I'm looking for"** — sortable table with
sparklines for quick scanning.

---

## Adding a New Visualization

1. Check the decision table above — does an existing component fit?
2. If not, create a new component in `src/components/` with:
   - Clear `Props` interface with JSDoc on each prop
   - A `*.test.ts` for pure logic (threshold calculations, formatting)
   - Grafana theme integration via `useStyles2` / `useTheme2`
3. Add an entry to this guide with "when to use" / "when not to use"
4. Ensure the component works in both light and dark Grafana themes
