.PHONY: check lint test build dev clean

## Run all quality checks (lint + typecheck + test)
check: lint test

## Lint both Go and TypeScript
lint:
	golangci-lint run ./...
	pnpm run lint
	pnpm run typecheck

## Run all tests
test:
	go test -race -count=1 ./pkg/...
	pnpm run test:ci

## Build frontend and backend
build:
	pnpm run build
	mage -v buildAll

## Start development environment (frontend watch + Docker stack)
dev:
	@echo "Starting Docker stack..."
	docker compose up -d
	@echo "Starting frontend watch..."
	pnpm run dev

## Remove build artifacts
clean:
	rm -rf dist/ coverage/
