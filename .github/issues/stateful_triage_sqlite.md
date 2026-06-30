# Feature Request: Stateful Issue Triage (Resolve/Ignore/Assign) for Frontend Exceptions

## Description
Currently, Nais APM groups exceptions dynamically in the frontend tab, but the dashboard is stateless. Once an error occurs, it remains visible in the active dashboard view for the duration of the selected time range. There is no way for a developer to mark a bug as "Resolved", "Ignored", or "Assigned" similar to Sentry's workflow.

We want to introduce a local SQLite database in the Go backend plugin to store issue metadata (`hash`, `state`, `assignee`) and integrate state management controls directly into the `ExceptionDrawer` UI.

## Proposed Architecture
1.  **Backend Data Store**:
    *   Initialize a local SQLite database file `nais_apm_issues.db` within Grafana's persistent data directory (`/var/lib/grafana/plugins/nais-apm-app/data/`).
    *   Create a schema table:
        ```sql
        CREATE TABLE IF NOT EXISTS issues (
            hash TEXT PRIMARY KEY,
            status TEXT DEFAULT 'active', -- 'active', 'resolved', 'ignored'
            assignee TEXT,
            resolved_at DATETIME,
            updated_at DATETIME
        );
        ```
2.  **Plugin API Extensions**:
    *   Expose HTTP REST endpoints for state mutations:
        *   `POST /api/plugins/nais-apm-app/resources/issues/:hash/resolve`
        *   `POST /api/plugins/nais-apm-app/resources/issues/:hash/ignore`
        *   `POST /api/plugins/nais-apm-app/resources/issues/:hash/assign`
    *   Expose a GET endpoint to fetch issue states:
        *   `GET /api/plugins/nais-apm-app/resources/issues/states` (returns a map of `hash -> status`)
3.  **Frontend Dashboard Filtering**:
    *   In `sections.ts`, when rendering the "Top Exceptions" table, fetch active issue states from the plugin backend.
    *   Filter out any rows where the exception `hash` is marked as `resolved` or `ignored` in SQLite.
4.  **UI Controls**:
    *   Add "Resolve", "Ignore", and "Assignee" selection controls directly into the `ExceptionDrawer` header.
    *   When clicked, trigger the backend REST mutation and immediately refresh the parent dashboard data.
