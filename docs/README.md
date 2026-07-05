# Documentation

Reference, specification, decision, and design records for the Nais APM
Grafana plugin (release **v0.20.0 "Legend"**). Planning and roadmap live on
GitHub, not here — see [Planning & roadmap](#planning--roadmap) below.

For installation and a quick overview, see the [project README](../README.md).
For development setup, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Reference & specifications

Contracts and reference material — keep these current with the product.

| Document | Contents |
|----------|----------|
| [configuration.md](configuration.md) | Datasource setup, per-environment overrides, authentication, auto-detection, framework-detection troubleshooting, deploy annotations, metrics pipeline |
| [metrics-reference.md](metrics-reference.md) | Complete metrics, labels, dimensions, query patterns, collector configuration, and endpoint classification |
| [url-contract.md](url-contract.md) | Stable URL/query-param API — tab routes (incl. legacy `tab=server`/`tab=runtime` → `tab=backend` aliases), fleet routes, Exception Drawer deep links, issue facets |
| [security-model.md](security-model.md) | Authorization model, hardening notes, and the accepted-design decisions from the resource-endpoint security audit |
| [triage.md](triage.md) | Issue-triage storage contract (org-annotation event log), endpoints, consistency/HA expectations, retention requirement |
| [visualizations.md](visualizations.md) | Component guide — when to use bullet graphs, sparklines, health dots, stat boxes, attention lists, and Scene panels |

## API reference

| Document | Contents |
|----------|----------|
| [api/README.md](api/README.md) | Canonical HTTP resource-API reference (services, issues, frontend, alert templates, platform), OpenAPI spec, and CI-gate examples |

## Decision records (ADRs)

| Document | Contents |
|----------|----------|
| [adr/0001-state-in-grafana-shared-db.md](adr/0001-state-in-grafana-shared-db.md) | Why plugin state lives in Grafana's shared DB (annotations) rather than a plugin-owned store — audit, revisit triggers, escalation ladder |

## Design records

The "why" behind the UX and the information architecture. `design-philosophy.md`
is living reference; the IA reviews are dated records of decisions that shipped.

| Document | Contents |
|----------|----------|
| [design-philosophy.md](design-philosophy.md) | UX principles, observability strategy (RED + drill-down), cognitive-load budget, visual-design rules, dashboard archetypes, anti-patterns |
| [ia-review.md](ia-review.md) | First IA review (2026-07-03, shipped) — the Issues-tab split and the M6 move list; tab order later superseded by ia-review-2 |
| [ia-review-2.md](ia-review-2.md) | Second IA review (2026-07-04, shipped in #71) — the tab/layout rubric plus the Endpoints+Runtime → **Backend** merge and the new **Alerts** tab |

## QA & verification

| Document | Contents |
|----------|----------|
| [qa/data-review.md](qa/data-review.md) | Repeatable data-conformance check: backend queries vs. the data that actually exists in the production-proxied datasources |
| [qa/smoke-tests.md](qa/smoke-tests.md) | Repeatable smoke check of the real-environment contracts the plugin depends on |

## Planning & roadmap

Roadmap, rollout plan, and the audit/adoption analyses moved to GitHub and are
no longer tracked in this directory:

- **Milestones** — "v0.20.0 — Legend" and "v1.0 — Platform maturity".
- **Roadmap tracking issue [#91](https://github.com/nais/grafana-apm-app/issues/91)** — vision, tracks, and standing risks (the former `docs/roadmap.md` is preserved verbatim as a comment there).
- **Rollout epic [#89](https://github.com/nais/grafana-apm-app/issues/89)** — the former `docs/plans/rollout.md` checklist.
- **Loki/Tempo adoption [#85](https://github.com/nais/grafana-apm-app/issues/85)** and **Faro/Sentry audit [#79](https://github.com/nais/grafana-apm-app/issues/79)** — the former analysis docs.
</content>
</invoke>
