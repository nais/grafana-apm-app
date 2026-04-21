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
mise run ls                   # List all tasks
mise run all                  # Full check + test + build
mise run check                # Lint + typecheck + format (frontend & backend)
mise run test                 # All tests (Jest + Go)
mise run build                # Production build (frontend + backend)
mise run frontend:check       # Typecheck, ESLint, Prettier
mise run frontend:test        # Jest unit tests
mise run frontend:build       # Webpack production build
mise run frontend:dev         # Frontend watch mode
mise run backend:check        # go vet + golangci-lint
mise run backend:test         # Go tests with -race
mise run backend:build        # mage buildAll (all platforms)
mise run deploy                # Build all + restart Grafana
mise run deploy:up             # Start full local stack
mise run deploy:down           # Stop local stack
mise run deploy:restart        # Restart Grafana (pick up new dist/)
mise run deploy:logs           # Tail Grafana logs
mise run deploy:status         # Show containers + health check
mise run deploy:demo           # Start stack with OTel Demo traffic
mise run dev                  # Docker stack + frontend watch
mise run clean                # Remove dist/ and coverage/
pnpm run e2e                  # Playwright E2E (needs running stack)
docker compose up             # Full LGTM dev stack
docker compose -f docker-compose.demo.yaml up  # With OTel Demo traffic
```

## Patterns

- **Scenes framework** — panels use `@grafana/scenes` (`PanelBuilders`, `SceneQueryRunner`, `EmbeddedScene`), not raw `<PanelRenderer>`
- **Backend proxy** — Go backend proxies to Mimir/Tempo/Loki via Grafana's datasource proxy (`/api/datasources/proxy/uid/{uid}`), never direct URLs
- **Capability detection** — backend auto-detects metric namespaces, duration units, and available signals; frontend adapts UI based on capabilities
- **Per-environment datasources** — config supports mapping `deployment.environment` values to different Tempo/Loki UIDs
- **Plugin ID** — `nais-apm-app` in URLs, binary is `gpx_application_observability`

## Constraints

- **Do not push** — git credential helper (`osxkeychain`) is unavailable in agent sessions. Stage and commit freely; the user will push.
- **No co-author trailers** — do not add `Co-authored-by` lines to commit messages.
- **Always run `mise run all` after every coding session** — before committing or marking a task complete, run the full check+test+build pipeline to catch regressions.

## Testing

- Unit tests live next to source files (`*.test.tsx`)
- Backend tests: `go test ./...`
- E2E tests need `docker compose up` running first
- CI runs typecheck → lint → test → build → e2e (see `.github/workflows/ci.yml`)
