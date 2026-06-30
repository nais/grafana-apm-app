# Feature Request: Self-Hosted rrweb Session Replay Player

## Description
To replicate Sentry's session replay capability, we want to embed the open-source `rrweb-player` library inside the Nais APM Grafana plugin. This allows developers to visually play, pause, and speed up recordings of user browser sessions directly within Grafana, using raw telemetry logs stored in your self-hosted Loki database.

## Proposed Architecture
1.  **Ingestion & Telemetry**:
    *   Ensure applications initialize the Faro Web SDK with `ReplayInstrumentation` (which records DOM changes via `rrweb`).
    *   Faro streams these events batch-by-batch to the Alloy collector, which indexes them in Loki under `kind="log"` or `kind="event"` with the corresponding `session_id`.
2.  **Loki Query in Frontend**:
    *   Add a "Play Replay" button in the `ExceptionDrawer` UI if the exception log has an associated `session_id`.
    *   When clicked, trigger a Loki query to fetch all logs containing the session ID:
        ```logql
        {service_name="my-app", kind="event"} | logfmt | session_id="AdLX3Vqzrh"
        ```
    *   Sort the returned events chronologically by timestamp.
3.  **UI Player Integration**:
    *   Add `rrweb-player` and `@types/rrweb` as dev dependencies.
    *   In the plugin client, render a modal overlay hosting the `<rrweb-player>` component.
    *   Feed the parsed, ordered array of JSON DOM mutation events to the player.
4.  **PII Safety Configuration**:
    *   Document the requirement to configure Faro with `maskAllInputs: true` and block sensitive classes/IDs to prevent leaking PII or credentials into Loki streams.
