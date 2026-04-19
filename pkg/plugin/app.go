package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

var (
	_ backend.CallResourceHandler   = (*App)(nil)
	_ instancemgmt.InstanceDisposer = (*App)(nil)
	_ backend.CheckHealthHandler    = (*App)(nil)
)

// App is the Application Observability plugin backend.
type App struct {
	backend.CallResourceHandler

	settings   queries.PluginSettings
	promClient *queries.PrometheusClient
	tempoURL   string
	lokiURL    string

	capMu    sync.RWMutex
	capCache *cachedCapabilities
}

// NewApp creates a new App instance, parsing datasource configuration from jsonData.
func NewApp(_ context.Context, settings backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	logger := log.DefaultLogger.With("component", "app")

	var app App

	// Parse plugin settings from jsonData
	if len(settings.JSONData) > 0 {
		if err := json.Unmarshal(settings.JSONData, &app.settings); err != nil {
			logger.Warn("Failed to parse plugin jsonData", "error", err)
		}
	}

	// For Phase 1, use direct URLs to datasources within the Docker network.
	// TODO: Abstract to use Grafana datasource proxy for production deployments.
	app.promClient = queries.NewPrometheusClient("http://mimir:9009/prometheus")
	app.tempoURL = "http://tempo:3200"
	app.lokiURL = "http://loki:3100"

	logger.Info("Plugin initialized",
		"metricsDS", app.settings.MetricsDataSource.UID,
		"tracesDS", app.settings.TracesDataSource.UID,
		"logsDS", app.settings.LogsDataSource.UID,
	)

	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.CallResourceHandler = httpadapter.New(mux)

	return &app, nil
}

func (a *App) Dispose() {}

// CheckHealth validates datasource connectivity.
func (a *App) CheckHealth(ctx context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	caps := a.detectCapabilities(ctx)

	if !caps.SpanMetrics.Detected {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "No span metrics detected in Mimir. Ensure the OTel Collector spanmetrics connector is configured.",
		}, nil
	}

	if !caps.Tempo.Available {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "Tempo is not reachable: " + caps.Tempo.Error,
		}, nil
	}

	details, _ := json.Marshal(caps)
	msg := fmt.Sprintf("OK — %s metrics detected, %d services found", caps.SpanMetrics.Namespace, len(caps.Services))
	return &backend.CheckHealthResult{
		Status:      backend.HealthStatusOk,
		Message:     msg,
		JSONDetails: details,
	}, nil
}

func (a *App) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/capabilities", a.handleCapabilities)
	mux.HandleFunc("/services", a.handleServices)
	mux.HandleFunc("/services/{namespace}/{service}/operations", a.handleOperations)
	mux.HandleFunc("/ping", a.handlePing)
}
