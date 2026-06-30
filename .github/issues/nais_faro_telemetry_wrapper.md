# Feature Request: Platform Wrapper Package (`@navikt/faro-telemetry`)

## Description
To simplify Faro onboarding and enforce best practices (PII masking, telemetry data sanitization, and distributed tracing), we want to provide a platform-managed npm wrapper package `@navikt/faro-telemetry`. This package will initialize the Faro Web SDK with zero-configuration and enable production-centric developer features by default.

## Proposed Features
1.  **Zero-Configuration Metadata Resolution**:
    *   Parse K8s app information, namespace, and version directly from standard HTML `<meta>` tags (injected dynamically during container deployment routing by the NAIS platform):
        *   `<meta name="nais-app" content="...">`
        *   `<meta name="nais-cluster" content="...">`
        *   `<meta name="nais-version" content="...">`
2.  **Automatic Distributed Tracing**:
    *   Pre-configure OpenTelemetry tracing and inject the `traceparent` header on all fetch/XHR requests.
    *   Automatically restrict header injection to `*.nav.no` and relative routes to prevent CORS failures or credential leaks to external third-party sites.
3.  **Global PII Masking and GDPR Safeguards**:
    *   Enable `maskAllInputs: true` by default in the rrweb session replay instrumentation.
    *   Sanitize emails, URLs, and Norwegian national identity numbers (Fødselsnummer) from the exception `value` in the `beforeSend` callback before hashing.
4.  **Integrated React Error Boundary (`NaisErrorBoundary`)**:
    *   Provide a React component wrapper that renders a standardized NAV-styled error card page showing a custom "Reference ID" (derived from the Faro `session_id` or exception `hash`).
    *   Capture React component trees and attach them as metadata to Loki.
5.  **User Session Contextualization**:
    *   Check NAV's `/oauth2/session` session endpoint on boot to extract and set the hashed user identifier dynamically in Faro.
