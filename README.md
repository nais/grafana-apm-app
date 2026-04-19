# Grafana OTel Application Observability Plugin

A self-hosted Grafana app plugin that provides Application Observability
using OpenTelemetry data from Mimir (metrics), Loki (logs), and Tempo (traces).

## Development

```bash
npm install
npm run dev       # frontend watch mode
mage -v build:linux  # backend build
docker compose up    # full LGTM stack
```

## License

Apache-2.0
