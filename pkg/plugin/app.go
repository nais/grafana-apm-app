package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
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

// App is the Nais APM plugin backend.
type App struct {
	backend.CallResourceHandler

	settings   queries.PluginSettings
	promClient *queries.PrometheusClient
	grafanaURL string // base URL for datasource proxy resolution

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

	// Resolve datasource URLs via Grafana datasource proxy.
	// GF_APP_URL is set by Grafana; fall back to localhost for development.
	app.grafanaURL = strings.TrimRight(os.Getenv("GF_APP_URL"), "/")
	if app.grafanaURL == "" {
		app.grafanaURL = "http://localhost:3000"
	}

	if uid := app.settings.MetricsDataSource.UID; uid != "" {
		proxyURL := fmt.Sprintf("%s/api/datasources/proxy/uid/%s", app.grafanaURL, uid)
		app.promClient = queries.NewPrometheusClient(proxyURL)
		logger.Info("Metrics datasource configured via proxy", "uid", uid)
	} else {
		// Fallback for unconfigured plugin (e.g., first install before config is saved)
		logger.Warn("No metrics datasource configured — plugin will not function until configured")
	}

	logger.Info("Plugin initialized",
		"metricsDS", app.settings.MetricsDataSource.UID,
		"tracesDS", app.settings.TracesDataSource.UID,
		"logsDS", app.settings.LogsDataSource.UID,
		"envOverrides", len(app.settings.TracesDataSource.ByEnvironment)+len(app.settings.LogsDataSource.ByEnvironment),
		"grafanaURL", app.grafanaURL,
	)

	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.CallResourceHandler = httpadapter.New(mux)

	return &app, nil
}

func (a *App) Dispose() {}

// proxyURL builds a Grafana datasource proxy URL for the given UID.
func (a *App) proxyURL(uid string) string {
	if uid == "" {
		return ""
	}
	return fmt.Sprintf("%s/api/datasources/proxy/uid/%s", a.grafanaURL, uid)
}

// tempoURL returns the Tempo proxy URL, optionally resolved for a specific environment.
func (a *App) tempoURL(env string) string {
	return a.proxyURL(a.settings.TracesDataSource.Resolve(env).UID)
}

// lokiURL returns the Loki proxy URL, optionally resolved for a specific environment.
func (a *App) lokiURL(env string) string {
	return a.proxyURL(a.settings.LogsDataSource.Resolve(env).UID)
}

// serviceGraphPrefix returns the detected service graph metric prefix.
// Falls back to "traces_service_graph" if not yet detected.
func (a *App) serviceGraphPrefix() string {
	a.capMu.RLock()
	defer a.capMu.RUnlock()
	if a.capCache != nil && a.capCache.caps.ServiceGraph.Prefix != "" {
		return a.capCache.caps.ServiceGraph.Prefix
	}
	return "traces_service_graph"
}

// promClientForRequest returns a PrometheusClient with the incoming user's auth headers.
func (a *App) promClientForRequest(r *http.Request) *queries.PrometheusClient {
	if a.promClient == nil {
		return nil
	}
	return a.promClient.WithAuthHeaders(r.Header)
}

// Context key for per-request PrometheusClient with forwarded auth.
type promClientCtxKey struct{}

// withAuthContext stores an auth-enhanced PrometheusClient in the context.
func withAuthContext(ctx context.Context, c *queries.PrometheusClient) context.Context {
	return context.WithValue(ctx, promClientCtxKey{}, c)
}

// prom returns the per-request auth-enhanced PrometheusClient, or falls back to the base client.
func (a *App) prom(ctx context.Context) *queries.PrometheusClient {
	if c, ok := ctx.Value(promClientCtxKey{}).(*queries.PrometheusClient); ok && c != nil {
		return c
	}
	return a.promClient
}

// CheckHealth validates datasource connectivity.
func (a *App) CheckHealth(ctx context.Context, req *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	// Forward auth headers from the health check request for datasource proxy calls
	h := make(http.Header)
	for k, v := range req.Headers {
		h.Set(k, v)
	}
	if a.promClient != nil {
		ctx = withAuthContext(ctx, a.promClient.WithAuthHeaders(h))
	}

	caps := a.detectCapabilities(ctx)

	if !caps.SpanMetrics.Detected {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "No span metrics detected in Mimir. Ensure the OTel Collector spanmetrics connector is configured.",
		}, nil
	}

	if !caps.Tempo.Available && len(caps.TempoByEnv) == 0 {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "Tempo is not reachable: " + caps.Tempo.Error,
		}, nil
	}

	details, err := json.Marshal(caps)
	if err != nil {
		log.DefaultLogger.Warn("Failed to marshal capabilities", "error", err)
		details = []byte("{}")
	}
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
	mux.HandleFunc("/services/{namespace}/{service}/endpoints", a.handleEndpoints)
	mux.HandleFunc("/services/{namespace}/{service}/frontend", a.handleFrontendMetrics)
	mux.HandleFunc("/services/{namespace}/{service}/dependencies", a.handleServiceDependencies)
	mux.HandleFunc("/services/{namespace}/{service}/connected", a.handleConnectedServices)
	mux.HandleFunc("/service-map", a.handleServiceMap)
	mux.HandleFunc("/dependencies", a.handleGlobalDependencies)
	mux.HandleFunc("/dependencies/{name}", a.handleDependencyDetail)
	mux.HandleFunc("/ping", a.handlePing)
}
