# Contributing

Contributions are welcome. For minor changes, feel free to open a pull request
directly. For larger changes or new features, open an issue first so we can
discuss the approach.

## Development setup

### Prerequisites

- Node.js 22 (use `nvm install` — the repo includes an `.nvmrc`)
- Go 1.25+
- Docker

### Getting started

1. Clone the repo and install dependencies:

   ```bash
   git clone https://github.com/nais/grafana-otel-plugin.git
   cd grafana-otel-plugin
   npm install
   ```

2. Start the development stack (Grafana + Mimir + Tempo + Loki + OTel Collector):

   ```bash
   docker compose up
   ```

3. In a separate terminal, run the frontend in watch mode:

   ```bash
   npm run dev
   ```

4. Open Grafana at `http://localhost:3000` (default login: `admin` / `admin`)

### Backend

The Go backend is built with [Mage](https://magefile.org/):

```bash
mage -v build:linux
```

Restart the Docker Compose stack to pick up backend changes.

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
npm run test        # Unit tests (watch mode)
npm run test:ci     # Unit tests (CI)
npm run typecheck   # TypeScript type checking
npm run lint        # ESLint
npm run e2e         # Playwright E2E tests
```

## Pull requests

- Create a feature branch from `main`
- Make sure checks pass: `npm run test:ci && npm run typecheck && npm run lint`
- Write tests for new functionality
- Keep PRs focused — one feature or fix per PR

## Reporting issues

- **Bugs**: Open an issue with steps to reproduce, expected vs actual behavior, and your Grafana/plugin version
- **Feature requests**: Open an issue describing the use case and proposed solution

## Code style

- TypeScript for the frontend, Go for the backend
- ESLint and Prettier are configured — run `npm run lint:fix` before committing
- Follow existing patterns in the codebase
