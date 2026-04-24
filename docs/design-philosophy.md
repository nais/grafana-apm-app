# Design Philosophy

UX and information design principles for the Nais APM plugin, written for
a context where **full-stack developers own and operate their own services
in production** ("you build it, you run it").

This document synthesizes research from Grafana's dashboard best practices,
Google's SRE Workbook, Brendan Gregg's USE method, Tom Wilkie's RED method,
Charity Majors' observability writing, Edward Tufte's information design
principles, and Stephen Few's dashboard design patterns.

---

## Table of Contents

1. [Target Audience](#target-audience)
2. [Core Principles](#core-principles)
3. [Observability Strategy: RED + Drill-Down](#observability-strategy-red--drill-down)
4. [Information Hierarchy](#information-hierarchy)
5. [Cognitive Load Budget](#cognitive-load-budget)
6. [Visual Design Rules](#visual-design-rules)
7. [Navigation & Drill-Down](#navigation--drill-down)
8. [Time & Context Preservation](#time--context-preservation)
9. [Health Classification Philosophy](#health-classification-philosophy)
10. [Dashboard Archetypes](#dashboard-archetypes)
11. [Anti-Patterns to Avoid](#anti-patterns-to-avoid)
12. [Relationship to Other Docs](#relationship-to-other-docs)

---

## Target Audience

Our primary user is a **full-stack developer who is on-call for the services
they build**. This person:

- Writes code daily; monitoring is a secondary task, not their full-time job.
- Gets paged at 2 AM and needs to go from "something is wrong" to "here is
  the problem" in under 60 seconds.
- Owns 2–10 services across namespaces; needs a team-level view before
  diving into one service.
- Has limited time and attention — every unnecessary panel, metric, or click
  is a tax on their cognitive budget.
- Understands their code deeply but may not know PromQL, LogQL, or TraceQL.
- Cares about **user-facing symptoms** (errors, latency) more than
  infrastructure metrics (CPU, memory, disk).

This is NOT a tool for dedicated SRE teams operating hundreds of services,
nor for executives reading weekly reports. It's for the developer who
**deployed on Friday and wants to sleep well**.

---

## Core Principles

### 1. Answer "Do I need to act?" first

Every page should answer this question within 2 seconds of loading. If
everything is fine, the page should feel calm (neutral colors, no highlighted
sections). If something needs attention, it should be visually obvious
without reading any numbers.

> *"A dashboard should tell a story or answer a question."*
> — Grafana dashboard best practices

### 2. Show symptoms, not causes

Following the RED method (Rate, Errors, Duration), surface user-facing
signals first: error rates, latency percentiles, request rates. These are
direct proxies for user experience. Leave infrastructure metrics (CPU,
memory, GC pauses) to dedicated detail tabs where they serve as clues
during root-cause investigation.

> *"The USE method tells you how happy your machines are. The RED method
> tells you how happy your users are."*
> — Tom Wilkie

### 3. Reduce cognitive load, don't add to it

Every element on screen must earn its place. Apply Tufte's **data-ink
ratio**: maximize the proportion of visual elements that represent actual
data. Remove decorative borders, redundant labels, and chrome that doesn't
help the user answer their current question.

> *"Dashboards should reduce cognitive load, not add to it."*
> — Grafana dashboard best practices

### 4. Progressive disclosure over information overload

Show the minimum viable information at each level. The team page shows
health and counts. The service page shows RED panels. The detail tabs
show raw queries and distributions. Never force the user to process
information that belongs to a deeper level.

### 5. Consistency enables speed

Use the same layout, color semantics, and component patterns across all
pages. When a developer knows that 🔴 always means >5% error rate, that
sparklines always show the selected time range, and that clicking a service
name always navigates to its detail page — they can move fast without
thinking about the UI.

### 6. Context survives navigation

When drilling down from the team page to a service, or from an overview
tab to traces, preserve the time range, environment filter, and any other
active context. Losing context forces the user to re-establish their
investigation state, which wastes time during incidents.

---

## Observability Strategy: RED + Drill-Down

We adopt the **RED method** as our primary observability framework, with
hierarchical drill-down as the navigation pattern.

### Why RED over USE or Four Golden Signals?

| Method | Focus | Our usage |
|--------|-------|-----------|
| **USE** (Utilization, Saturation, Errors) | Infrastructure resources | Not used — our users care about services, not machines. K8s handles infrastructure. |
| **RED** (Rate, Errors, Duration) | Service endpoints | **Primary** — every service shows these three metrics. |
| **Four Golden Signals** (Latency, Traffic, Errors, Saturation) | Services + capacity | Partially — we show latency, traffic, and errors. Saturation is an infrastructure concern handled by the platform. |

### RED at every level

| Level | Rate | Errors | Duration |
|-------|------|--------|----------|
| **Namespace** | Total req/s (sparkline) | Services with errors (X of Y) | — (max P95 is misleading across services) |
| **Service** | Req/s (time series) | Error rate % (time series) | P50/P95/P99 (time series + heatmap) |
| **Endpoint** | Req/s per route | Error rate per route | Duration distribution per route |

Duration is intentionally absent from the namespace level because aggregating
P95 across heterogeneous services produces a meaningless number. We surface
latency health via the health classification system instead.

---

## Information Hierarchy

Our pages follow a strict **overview → focus → detail** hierarchy,
inspired by Shneiderman's Visual Information Seeking Mantra:

> *"Overview first, zoom and filter, then details on demand."*

```
Level 0: Service Inventory
  "Find the service I'm looking for"
  → Sortable table, search, sparklines

Level 1: Namespace / Team Page
  "Do any of my services need attention?"
  → Health counts, attention list, topology

Level 2: Service Overview
  "What's happening with this service?"
  → RED time series, key stats

Level 3: Service Detail Tabs
  "Why is this happening?"
  → Heatmaps, traces, logs, runtime metrics

Level 4: External Drill-Down
  "Show me the specific request"
  → Trace detail view, log lines, Grafana Explore
```

Each level answers a more specific question. **No level should display
information that belongs to a deeper level.** A namespace page should
never show per-endpoint latency heatmaps. A service overview should never
show individual trace waterfall diagrams.

---

## Cognitive Load Budget

Treat screen real estate as a **budget** and every visual element as a
**cost**. The user arrives with limited attention — especially during an
incident at 2 AM.

### Budget allocation per page

| Page | Primary question | Budget allocation |
|------|-----------------|-------------------|
| Namespace | "Do I need to act?" | 70% status/health, 20% navigation, 10% context |
| Service overview | "What's wrong?" | 60% RED time series, 25% stats, 15% navigation |
| Detail tab | "Why?" | 80% data panels, 10% filters, 10% navigation |

### Rules

1. **≤ 7 stat boxes** per page (Miller's law — 7 ± 2 chunks).
2. **≤ 5 items** in an attention/ranking list before it becomes a table.
3. **No panel should require horizontal scrolling** on a 1440px-wide screen.
4. **One primary action per page section** — if a section has both a
   filter dropdown and a navigation link and a sort toggle, consider
   splitting it.

---

## Visual Design Rules

### Color semantics

Color is the most powerful preattentive attribute. Use it consistently
and sparingly.

| Color | Meaning | Used for |
|-------|---------|----------|
| 🟢 Green | Healthy / good | Health dots, stat boxes when all services are healthy |
| 🟡 Yellow/amber | Warning / degraded | Health dots, topology borders (1–5% error rate) |
| 🔴 Red | Critical / failing | Health dots, topology borders (>5% error rate) |
| Blue/default | Neutral / informational | Standard stat boxes, sparklines, rate metrics |
| Gray | Inactive / no data | Disabled states, "no previous period" |

**Rules:**
- Never use red for something that isn't a problem.
- Never use green for something that could be bad (e.g., "high throughput"
  isn't necessarily good).
- Don't use color as the _only_ indicator — always pair with text or
  shape (🟢🟡🔴 emoji, ↑↓→ arrows) for accessibility.

### Typography hierarchy

1. **Stat values**: Largest font, bold. The number should be readable from
   2 meters away on a wall display.
2. **Stat labels**: Smaller, muted. Describes what the number is.
3. **Table data**: Standard body font. Dense but readable.
4. **Supplementary info**: Smallest. Deltas, units, previous-period values.

### Data-ink ratio (Tufte)

- **Sparklines** over full charts when trend direction is sufficient.
- **Health dots** over gauge panels when good/warning/critical is sufficient.
- **"X of Y"** over percentage bars when the denominator matters.
- **No chart borders, shadows, or decorative gradients.**
- If removing an element doesn't reduce understanding, remove it.

### Preattentive attributes (Stephen Few)

Use these sparingly to draw instant attention to problems:

| Attribute | Our usage |
|-----------|-----------|
| **Color hue** | Health dots (🟢🟡🔴), topology borders |
| **Size** | Stat box values are large; supplementary text is small |
| **Position** | "Needs Attention" section is above the table, not below |
| **Motion** | Reserved for sparkline animation (not currently used) |
| **Enclosure** | Card borders on stat boxes group related numbers |

**Rule:** If everything is highlighted, nothing is highlighted. Reserve
strong visual signals (red, bold, top-of-page position) for genuine
problems.

---

## Navigation & Drill-Down

### Overview → detail pattern

Every drill-down should follow this pattern:

```
[Something looks wrong in overview]
  → Click → [Scoped detail view]
    → Click → [Root-cause data]
```

**Maximum 3 clicks from "I see a problem" to "I'm looking at the
relevant traces/logs."**

### Drill-down paths we support

| Starting point | Click target | Destination |
|---------------|-------------|-------------|
| Namespace attention list | Service name | Service overview |
| Namespace services table | Service row | Service overview |
| Namespace topology | Service node | Service overview |
| Service RED panels | Time range drag | Zoomed time range |
| Service traces tab | Trace row | Trace detail (external) |
| Service logs tab | Log line | Log context (external) |

### Breadcrumb trail

Every drill-down page should make it easy to go back:

```
Namespace: my-team  →  Service: payment-api  →  Tab: Server
```

The user should always know where they are and be able to go back one
level without using the browser back button.

---

## Time & Context Preservation

### Time range

- **Relative ranges** (`now-1h`, `now-6h`) are the default and recommended.
  They enable previous-period comparison and auto-refresh.
- **Absolute ranges** work but disable delta arrows and previous-period
  comparisons (we can't meaningfully define "the previous period" for an
  arbitrary absolute range).
- Time range must be preserved when navigating between pages.

### Environment filter

- The selected `deployment.environment` must persist across page navigations.
- Per-environment datasource routing (Tempo/Loki) depends on this.

### Previous-period comparison

- For relative ranges: the previous period is a window of equal duration
  immediately before the selected range (e.g., for `now-1h`, the previous
  period is `now-2h` to `now-1h`).
- Delta arrows (↑↓→) answer "is this new or ongoing?" — a critical
  question during incident triage.
- If previous-period data isn't available, show nothing (not "→" or "0%").

---

## Health Classification Philosophy

### Why classify at all?

Raw numbers require interpretation. During an incident, the user shouldn't
need to mentally calculate whether "0.042 error rate" is bad. A health
classification pre-computes this judgment.

### Threshold design principles

1. **Thresholds must be universal for the context.** Per-service SLOs would
   be ideal but require configuration we don't have. Our thresholds work
   for "most web services" — a reasonable default for a platform-wide tool.

2. **Error rate is the primary signal.** It directly correlates with user
   impact. A service with high latency but zero errors may be slow but
   isn't broken.

3. **Latency is a secondary signal.** A P95 of 5+ seconds is a warning
   even if error rate is zero, because it likely indicates degraded user
   experience. But it doesn't escalate to critical — slow ≠ broken.

4. **Error rate > latency in severity ordering.** A service with 6% error
   rate but 200ms P95 is critical. A service with 0% error rate but 8s
   P95 is warning. This matches developer intuition: errors page you,
   slowness creates tickets.

### Service vs dependency thresholds

Services and dependencies use different functions because their error rate
metrics have different scales:

| Context | Error rate format | Example | Function |
|---------|------------------|---------|----------|
| Service | Percentage (4.2 = 4.2%) | `ServiceSummary.errorRate` | `getServiceHealth()` |
| Dependency | Fraction (0.042 = 4.2%) | `NamespaceDependency.errorRate` | `getDependencyHealth()` |

Using one function for both would silently misclassify. This is
intentional, not accidental complexity.

### Thresholds are tunable, not sacred

Current thresholds (`SERVICE_THRESHOLDS`, `DEPENDENCY_THRESHOLDS` in
`utils/health.ts`) are reasonable defaults. They may evolve as we learn
from real-world usage. When changing them:

- Ensure all components that display health (table, attention list,
  topology, stat boxes) pick up the same constants.
- Update the threshold tables in `visualizations.md`.
- Consider adding user-configurable overrides as a future feature.

---

## Dashboard Archetypes

Drawing from Grafana's dashboard taxonomy, our plugin implements three
archetypes:

### 1. Triage dashboard (Namespace page)

**Purpose:** Answer "do I need to act?" quickly.
**Archetype:** Big-screen / status board optimized.
**Design:** Health counts, attention list, minimal interactivity.
**Grafana parallel:** Big-screen dashboards with stat/gauge panels and
threshold coloring.

Key characteristics:
- Scannable from across the room (or across the table in a standup).
- Auto-refreshable (tracked in [#30](https://github.com/nais/grafana-apm-app/issues/30)).
- TV/kiosk mode compatible (tracked in [#29](https://github.com/nais/grafana-apm-app/issues/29)).
- No raw PromQL or complex query patterns visible.

### 2. Investigation dashboard (Service overview)

**Purpose:** Answer "what's wrong?" and guide toward "why?"
**Archetype:** RED dashboard per service.
**Design:** Time series panels with interactive features (zoom, hover).
**Grafana parallel:** USE/RED dashboards with drill-down links.

Key characteristics:
- RED panels in consistent layout: rate left, errors center, duration right.
- Heatmap for latency distribution (shows bimodal distributions that
  percentile lines hide).
- Links to traces and logs filtered by the current time range.
- Service hierarchy reflected in tab organization.

### 3. Discovery dashboard (Service inventory)

**Purpose:** Answer "which service am I looking for?"
**Archetype:** Overview/drill-down root.
**Design:** Sortable, filterable table with inline sparklines.
**Grafana parallel:** Dashboard list / metrics exploration dashboard.

Key characteristics:
- Efficient scanning of many services (20–200).
- Inline sparklines for quick trend assessment without clicking.
- Sort by any column to find outliers (highest error rate, most traffic).
- Click to drill down into any service.

---

## Anti-Patterns to Avoid

These anti-patterns are drawn from Grafana's dashboard maturity model,
real-world incident response failures, and observability community
research. Each is followed by what we do instead.

### ❌ Dashboard sprawl

**Problem:** Uncontrolled growth of dashboards that no one curates.
**Our approach:** We are a plugin with fixed, curated pages — not a
collection of user-created dashboards. Each page has a single purpose
and is maintained in code.

### ❌ Information overload

**Problem:** Showing every available metric because it might be useful
someday.
**Our approach:** Each page shows only the metrics that answer its primary
question. Infrastructure metrics (CPU, memory) are not mixed with RED
metrics. Runtime details live on a dedicated tab.

### ❌ Ops-led design

**Problem:** Dashboards designed by SRE teams who think in infrastructure
terms, not in terms of the developer's service.
**Our approach:** Everything is organized by service → tab, not by metric
type → service. The developer starts from their service, not from "all
CPU graphs."

### ❌ Percentage-only aggregates

**Problem:** Showing "2.3% weighted error rate" across a namespace.
**Our approach:** Show "2 of 12 services with errors" — an unambiguous
count that doesn't hide a high-error-rate service behind high-traffic
healthy services.

### ❌ Stacked area charts for aggregates

**Problem:** Stacked areas look impressive but are hard to read —
only the bottom series has a flat baseline, so comparing series
requires mental subtraction.
**Our approach:** Use sparklines for compact trends, and full time series
panels (non-stacked) on detail pages where the user can hover and inspect.

### ❌ Alert fatigue through noise

**Problem:** Highlighting everything means nothing is highlighted.
**Our approach:** The "Needs Attention" section appears only when services
are unhealthy. Green health dots are visually quiet (they don't demand
attention). Red dots are rare and therefore noticeable.

### ❌ Context loss on navigation

**Problem:** Clicking into a service resets the time range to the default.
**Our approach:** Time range, environment, and namespace are preserved
in URL parameters across all navigations.

### ❌ Invisible failures (stale data)

**Problem:** A crashed service stops emitting metrics and disappears
from the service list — the worst state looks like "no problem."
**Our approach:** Documented as a known limitation
([#29 comment](https://github.com/nais/grafana-apm-app/issues/29)).
Future mitigation includes client-side "last seen" tracking and longer
lookback windows.

---

## Relationship to Other Docs

| Document | Relationship |
|----------|-------------|
| [visualizations.md](visualizations.md) | Component-level guide: _which_ visualization to use and _how_. This document explains _why_. |
| [configuration.md](configuration.md) | Datasource and environment setup — the "plumbing" that enables the UX. |
| [metrics-reference.md](metrics-reference.md) | The raw data that feeds into the visualizations and health classification. |

---

## References

- Grafana Labs. [Dashboard best practices](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/)
- Grafana Labs. [Dashboard types guide](https://grafana.com/blog/2022/06/06/grafana-dashboards-a-complete-guide-to-all-the-different-types-you-can-build/)
- Tom Wilkie. [The RED Method](https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/)
- Brendan Gregg. [The USE Method](https://www.brendangregg.com/usemethod.html)
- Google. [Monitoring Distributed Systems — Four Golden Signals](https://sre.google/sre-book/monitoring-distributed-systems/)
- Google. [Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)
- Charity Majors. [Observability: A 5-Year Retrospective](https://www.honeycomb.io/blog/observability-5-year-retrospective)
- Edward Tufte. *The Visual Display of Quantitative Information* (2001)
- Stephen Few. *Information Dashboard Design* (2013)
- Ben Shneiderman. *The Eyes Have It: A Task by Data Type Taxonomy for Information Visualizations* (1996)
- KubeCon 2019. [Fool-Proof Kubernetes Dashboards for Sleep-Deprived Oncalls](https://www.youtube.com/watch?v=YE2aQFiMGfY)
