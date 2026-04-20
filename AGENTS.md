# AGENTS.md

Grafana app plugin with a Go backend and React/TypeScript frontend.

## Structure

```
src/           → React frontend (Scenes, @grafana/ui)
  pages/       → Main views: ServiceInventory, ServiceOverview, ServiceMap
  components/  → Shared components, AppConfig
  api/         → TypeScript client for the Go backend
  utils/       → Query builders, formatters, constants
pkg/           → Go backend plugin (gRPC, proxies queries to Mimir/Tempo/Loki)
  plugin/      → App entrypoint, capability detection, service discovery
.config/       → Webpack, Jest, ESLint base configs (from Grafana scaffold)
provisioning/  → Grafana dev provisioning (datasources, plugin config)
tests/         → Playwright E2E tests
```

## Commands

```bash
pnpm install                  # Install frontend deps
pnpm run dev                  # Frontend watch mode
pnpm run build                # Production build
pnpm run test:ci              # Jest unit tests
pnpm run typecheck            # TypeScript check
pnpm run lint                 # ESLint
pnpm run e2e                  # Playwright E2E (needs running stack)
mage -v build:linux           # Build Go backend
docker compose up             # Full LGTM dev stack
docker compose -f docker-compose.demo.yaml up  # With OTel Demo traffic
```

## Patterns

- **Scenes framework** — panels use `@grafana/scenes` (`PanelBuilders`, `SceneQueryRunner`, `EmbeddedScene`), not raw `<PanelRenderer>`
- **Backend proxy** — Go backend proxies to Mimir/Tempo/Loki via Grafana's datasource proxy (`/api/datasources/proxy/uid/{uid}`), never direct URLs
- **Capability detection** — backend auto-detects metric namespaces, duration units, and available signals; frontend adapts UI based on capabilities
- **Per-environment datasources** — config supports mapping `deployment.environment` values to different Tempo/Loki UIDs
- **Plugin ID** — `nais-apm-app` in URLs, binary is `gpx_application_observability`

## Testing

- Unit tests live next to source files (`*.test.tsx`)
- Backend tests: `go test ./...`
- E2E tests need `docker compose up` running first
- CI runs typecheck → lint → test → build → e2e (see `.github/workflows/ci.yml`)
