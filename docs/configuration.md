# Configuration

How to set up datasources, authentication, and per-environment overrides for
the Nais APM app. For the full list of expected metrics and labels, see
[metrics-reference.md](metrics-reference.md).

---

## Datasources

The plugin needs three Grafana datasources:

| Signal  | Type        | Default UID | Purpose |
|---------|------------|-------------|---------|
| Metrics | Prometheus | `mimir`     | Span metrics, service graph, browser metrics, runtime metrics |
| Traces  | Tempo      | `tempo`     | Trace detail, exemplar links |
| Logs    | Loki       | `loki`      | Faro browser telemetry, application logs |

### Setup

1. Go to the plugin's **Configuration** page
2. Enter data source UIDs for Mimir, Tempo, and Loki
3. Click **Auto-detect capabilities** to verify connectivity and detect metric names
4. Save

---

## Auto-Detection

On startup (and when you click **Auto-detect**), the plugin probes Mimir to
discover which metrics exist. This determines which features are enabled.

### What Gets Detected

| Setting | Values | How |
|---------|--------|-----|
| Metric namespace | `traces_span_metrics`, `traces_spanmetrics`, `spanmetrics`, *(bare)* | Probes `{ns}_calls_total` in order |
| Duration unit | `ms` or `s` | Probes `{ns}_duration_milliseconds_bucket` then `{ns}_duration_seconds_bucket` then `{ns}_latency_bucket` |
| Service graph prefix | `traces_service_graph` or `service_graph` | Probes `{pfx}_request_total` |

See [metrics-reference.md — Auto-Detection](metrics-reference.md#auto-detection--capabilities)
for the full probe order.

### Manual Override

If auto-detection fails (e.g., restricted Mimir access), you can set the
namespace and duration unit manually on the plugin configuration page.

---

## Per-Environment Datasource Overrides

If you run separate Tempo/Loki instances per environment (e.g., `dev-gcp`,
`prod-gcp`), you can configure per-environment overrides. When a user selects
an environment filter, trace and log links will route to the matching
datasource instead of the default.

Each override maps an environment name (matching `deployment.environment`) to
a Tempo UID and/or Loki UID:

```json
{
  "tracesDataSource": {
    "uid": "tempo",
    "type": "tempo",
    "byEnvironment": {
      "dev-gcp": { "uid": "dev-gcp-tempo", "type": "tempo" },
      "prod-gcp": { "uid": "prod-gcp-tempo", "type": "tempo" }
    }
  },
  "logsDataSource": {
    "uid": "loki",
    "type": "loki",
    "byEnvironment": {
      "dev-gcp": { "uid": "dev-gcp-loki", "type": "loki" },
      "prod-gcp": { "uid": "prod-gcp-loki", "type": "loki" }
    }
  }
}
```

When a user selects an environment filter, the app resolves the matching
datasource UID. If no override exists, the default datasource is used.

---

## Authentication

When Grafana runs behind an OAuth2 proxy (e.g., Wonderwall on Nais), the
plugin backend cannot use forwarded browser cookies for internal API calls
because the cookies belong to the proxy, not to Grafana itself.

### Option 1 — Auto-managed (recommended, Grafana 10.3+)

Enable Grafana's `externalServiceAccounts` feature toggle and set
`auth.managed_service_accounts_enabled = true` in `grafana.ini`. The plugin
will automatically receive a managed service account token — no manual
configuration needed.

### Option 2 — Manual service account token

1. Go to **Administration > Service accounts** and create a new account
2. Assign **Viewer** role (only read access to datasources is needed)
3. Generate a token (starts with `glsa_`)
4. Paste it into the **Grafana Service Account Token** field on the plugin
   configuration page

### When Auth Is Not Needed

Auth is not needed for local development with anonymous auth or when Grafana
handles authentication directly (no OAuth2 proxy in front).

The plugin uses a 3-tier fallback: auto-managed token → manual token →
forwarded user headers.

---

## Framework Detection Troubleshooting

The service list shows a **type badge** (Ktor, Spring, Node.js, Go) next to
services where the framework can be detected from Prometheus metrics. If your
service doesn't show a badge:

1. **No Prometheus scraping** — detection metrics come from application-emitted
   Prometheus metrics (not OTel span metrics). Your pod must be scraped by
   Prometheus with `app` and `namespace` labels.
2. **Missing instrumentation library** — for JVM apps, you need Micrometer
   (typically via Spring Boot Actuator or Ktor metrics plugin). For Node.js,
   `prom-client` or the OTel Prometheus exporter. For Go, `prometheus/client_golang`.
3. **Label mismatch** — the `app` label on your Prometheus metrics must match
   the `service_name` on your OTel span metrics. In Nais, both default to the
   application name from `nais.yaml`.

See [metrics-reference.md — Framework Detection](metrics-reference.md#framework-detection)
for the full list of detection metrics.

---

## Metrics Pipeline

The plugin reads pre-aggregated **span metrics** and **service graph metrics**
from Mimir, not raw traces. These can be produced two ways:

### Option A: Tempo metrics-generator (recommended)

Tempo's built-in [metrics-generator](https://grafana.com/docs/tempo/latest/metrics-generator/)
derives metrics from ingested traces and remote-writes them to Mimir. This is
the approach used in production at Nav.

### Option B: OTel Collector connectors

The OTel Collector can generate equivalent metrics using the
[spanmetrics](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/spanmetricsconnector)
and [servicegraph](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/connector/servicegraphconnector)
connectors. This is the approach used in the local dev setup.

See [metrics-reference.md](metrics-reference.md) for detailed collector
configuration and the full set of required dimensions.
