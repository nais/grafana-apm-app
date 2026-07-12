# AGENTS.md

Grafana app plugin with a Go backend and React/TypeScript frontend.

## Structure

```
src/           → React frontend (Scenes, @grafana/ui)
  pages/       → Main views: ServiceInventory, ServiceOverview, ServiceMap, NamespaceOverview
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
mise run release              # Cut release (patch bump, or: -- minor/major/X.Y.Z)
pnpm run e2e                  # Playwright E2E (needs running stack)
docker compose up             # Full LGTM dev stack
docker compose -f docker-compose.demo.yaml up  # With OTel Demo traffic
```

## Patterns

- **Scenes framework** — panels use `@grafana/scenes` (`PanelBuilders`, `SceneQueryRunner`, `EmbeddedScene`), not raw `<PanelRenderer>`
- **Backend proxy** — Go backend proxies to Mimir/Tempo/Loki via Grafana's datasource proxy (`/api/datasources/proxy/uid/{uid}`), never direct URLs
- **Capability detection** — backend auto-detects metric namespaces, duration units, and available signals; frontend adapts UI based on capabilities
- **Per-environment datasources** — config supports mapping `deployment.environment` values to different Tempo/Loki UIDs
- **Plugin ID** — `nais-apm-app` in URLs, binary is `gpx_apm`

## Constraints

- **Push feature branches only** — never push to `main` directly; all changes land via PR. If the git credential helper is unavailable in your session (pushes fail with an auth error), stage and commit freely and let the user push — do not retry or fiddle with credentials.
- **Never amend pushed commits** — if a commit has been pushed to `origin`, do not `git commit --amend` it. Create a new fixup commit instead. Always check `git log --oneline origin/main..HEAD` before amending.
- **Never force push** — do not use `git push --force` or `--force-with-lease`. Always create forward-only history.
- **Never move tags** — do not delete or move existing git tags unless the user explicitly asks. If a tag was already pushed, it is immutable. Create the next version instead.
- **No co-author trailers** — do not add `Co-authored-by` lines to commit messages.
- **Always run `mise run all` after every coding session** — before committing or marking a task complete, run the full check+test+build pipeline to catch regressions.

## Gotchas & Troubleshooting

- **URL search params: one user action = ONE update call.**
  - react-router's `setSearchParams(prev => …)` functional updater receives the params of the *last render*, not the pending update — consecutive calls in the same React batch silently clobber each other. This caused the ExceptionDrawer close/reopen loop (v0.13.2–v0.13.4).
  - Use `useUrlParams()` from `src/utils/useUrlState.ts` and pass every param change for an action in a single call (`update({ a: '1', b: null })`). Never call two param setters for one user action.
- **i18n Duplicate Instances (`t()` error):**
  - `@grafana/i18n` must be bundled, but doing so under `pnpm` nested layout duplicates the module. We use Webpack `resolve.alias` in `.config/webpack/webpack.config.ts` to deduplicate it. Do not remove this alias.
  - `@grafana/schema` must be bundled instead of externalized to prevent deep-import 404s. Do not add it to `externals.ts`.
- **Backend Binary Missing (`App not found` / provisioning 404):**
  - If the `dist/` folder is deleted or cleaned, the Go backend binary is lost. Running `mise run dev` (or frontend build) alone will NOT compile the Go backend.
  - You must compile the Linux backend binaries (`CGO_ENABLED=0 GOOS=linux GOARCH=arm64/amd64 go build -o dist/gpx_apm_linux_... ./pkg`) and restart the Docker stack (`docker compose restart grafana`) for the plugin to be provisioned.

## Testing

- Unit tests live next to source files (`*.test.tsx`)
- Backend tests: `go test ./...`
- E2E tests need `docker compose up` running first
- CI runs typecheck → lint → test → build → e2e (see `.github/workflows/ci.yml`)
