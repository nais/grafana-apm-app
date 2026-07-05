# infra/actions

> **TARGET LOCATION:** each subdirectory here is a reference implementation
> to lift into its own standalone GitHub Action repo under the `nais` org
> (e.g. `nais/apm-deploy-annotation`), tagged and versioned independently.
> Nothing here is meant to be consumed with a local `uses: ./infra/actions/...`
> path from this repo — `grafana-otel-plugin` is the Grafana app plugin, not
> where teams' deploy workflows live.

## apm-deploy-annotation

Source: nais/grafana-apm-app#64 Phase 0. Posts a Grafana annotation marking
a deploy, tagged so Nais APM can render it as a marker on RED/frontend
charts and, in #64 Phase 2, drive regression detection. See
`apm-deploy-annotation/action.yml` for the full contract and design notes.

### Usage (once published as `nais/apm-deploy-annotation@v1`)

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # ... build, upload source maps to cdn.nav.no, nais deploy, etc ...

      - name: Record deploy in Nais APM
        uses: nais/apm-deploy-annotation@v1
        with:
          grafana-url: https://my-tenant.grafana.net
          grafana-token: ${{ secrets.GRAFANA_SA_TOKEN }}
          service: my-frontend
          namespace: my-team
          environment: prod-gcp
          # version: defaults to ${{ github.sha }} — only override with a
          # documented reason, since it's the join key for the CDN source-map
          # path, the @nais/apm release tag, and #64's regression detection.
```

### Preconditions

- The Grafana service account needs `annotations:create`. Whether the
  plugin's own managed service account can cover this, or whether teams
  need a separately provisioned token, is an open question tracked in #64
  Phase 2 (`iam.permissions` in `src/plugin.json` currently only declares
  `datasources:query`).
- GitHub-hosted runners must be able to reach the tenant Grafana API over
  the internet. This is typically true on nais-tenant Grafana, but per-tenant
  network policy may differ — verify before relying on this in CI (#64 calls
  this out explicitly as a Phase 0 precondition; Phase 2's server-side sync
  makes it moot).
- Retain annotations at least as long as your metric/log retention, or
  deploy markers and regression detection silently lose history older than
  the annotation retention window.
