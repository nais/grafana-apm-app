# Contributing

Contributions are welcome. For minor changes, feel free to open a pull request
directly. For larger changes or new features, open an issue first so we can
discuss the approach.

## Development setup

### Prerequisites

- Node.js 22 (use `nvm install` — the repo includes an `.nvmrc`)
- Go 1.25+
- Docker
- [golangci-lint](https://golangci-lint.run/docs/install/) v2+
- [Lefthook](https://github.com/evilmartians/lefthook) (optional, for git hooks)

### Getting started

1. Clone the repo and install dependencies:

   ```bash
   git clone https://github.com/nais/grafana-apm-app.git
   cd grafana-apm-app
   pnpm install
   ```

2. (Optional) Install pre-commit and pre-push hooks:

   ```bash
   lefthook install --force
   ```

3. Start the development stack (Grafana + Mimir + Tempo + Loki + OTel Collector):

   ```bash
   docker compose up
   ```

4. In a separate terminal, run the frontend in watch mode:

   ```bash
   pnpm run dev
   ```

5. Open Grafana at `http://localhost:3000` (default login: `admin` / `admin`)

### Backend

The Go backend is built with [Mage](https://magefile.org/):

```bash
mage -v build:linux
```

Restart the Docker Compose stack to pick up backend changes.

## Makefile

A unified `Makefile` wraps common tasks:

| Command       | What it does                              |
|---------------|-------------------------------------------|
| `make check`  | Lint + typecheck + test (both Go and TS)  |
| `make lint`   | golangci-lint + ESLint + tsc --noEmit     |
| `make test`   | Go tests (with race detector) + Jest      |
| `make build`  | Frontend webpack build + Mage buildAll    |
| `make dev`    | Start Docker stack + frontend watch       |
| `make clean`  | Remove dist/ and coverage/                |

## Code structure

| Directory | Contents |
|-----------|----------|
| `src/pages/` | Main page components (ServiceInventory, ServiceOverview, ServiceMap) |
| `src/components/` | Shared React components and plugin config page |
| `src/api/` | TypeScript API client for the Go backend |
| `src/utils/` | Query builders, formatting helpers, constants |
| `pkg/` | Go backend plugin (data proxying, service discovery, capability detection) |
| `provisioning/` | Grafana provisioning configs for development |
| `tests/` | Playwright end-to-end tests |

## Testing

```bash
# Frontend
pnpm run test        # Unit tests (watch mode)
pnpm run test:ci     # Unit tests (CI)
pnpm run typecheck   # TypeScript type checking
pnpm run lint        # ESLint
pnpm run e2e         # Playwright E2E tests

# Backend
go test -race ./pkg/...                # Go tests with race detector
golangci-lint run ./...                # Go linting

# All at once
make check
```

## Quality gates

### Pre-commit (via Lefthook)
- **gitleaks** — scans staged changes for secrets
- **golangci-lint** — lints changed Go files
- **ESLint** — lints TypeScript/React
- **tsc --noEmit** — type checking

### Pre-push (via Lefthook)
- **go test -race** — Go tests with race detector
- **Jest** — frontend unit tests

### CI
- All of the above, plus:
- **Prettier** — code formatting check
- **Go coverage** — enforced minimum threshold (currently 10%)
- **Playwright** — E2E tests against multiple Grafana versions
- **Plugin validator** — Grafana plugin metadata validation

## Pull requests

- Create a feature branch from `main`
- Run `make check` before pushing
- Write tests for new functionality
- Keep PRs focused — one feature or fix per PR

## Reporting issues

- **Bugs**: Open an issue with steps to reproduce, expected vs actual behavior, and your Grafana/plugin version
- **Feature requests**: Open an issue describing the use case and proposed solution

## Code style

- TypeScript for the frontend, Go for the backend
- ESLint and Prettier are configured — run `pnpm run lint:fix` before committing
- Go linting via `.golangci.yml` — run `golangci-lint run ./...`
- Follow existing patterns in the codebase
