// Package plugin implements the Grafana app plugin backend.
package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
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

	otelCfg      otelconfig.Config
	settings     queries.PluginSettings
	promClient   *queries.PrometheusClient
	healthClient *http.Client // shared client for health checks
	grafanaURL   string       // base URL for datasource proxy resolution
	serviceToken string       // Grafana service account token for internal API calls

	capMu    sync.RWMutex
	capCache *cachedCapabilities

	respCache *responseCache // short-lived response cache for expensive queries

	// ingressByService maps service_name → list of ingress hostnames that route to it.
	// Built from settings.IngressAliases (reversed). Used to expand caller queries.
	ingressByService map[string][]string
}

// NewApp creates a new App instance, parsing datasource configuration from jsonData.
func NewApp(_ context.Context, settings backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	logger := log.DefaultLogger.With("component", "app")

	var app App
	app.otelCfg = otelconfig.Default()
	app.respCache = newResponseCache(30*time.Second, 200)
	app.healthClient = &http.Client{Timeout: 10 * time.Second}

	// Parse plugin settings from jsonData
	if len(settings.JSONData) > 0 {
		if err := json.Unmarshal(settings.JSONData, &app.settings); err != nil {
			logger.Warn("Failed to parse plugin jsonData", "error", err)
		}
	}

	// Apply label overrides — allows non-standard OTel pipelines (e.g. Tempo metrics generator,
	// which emits "service" instead of "service_name") to work without infra-side relabeling.
	if o := app.settings.LabelOverrides; (o != queries.LabelOverrides{}) {
		validLabel := regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)
		applied := 0
		if o.ServiceName != "" {
			if validLabel.MatchString(o.ServiceName) {
				app.otelCfg.Labels.ServiceName = o.ServiceName
				applied++
			} else {
				logger.Warn("Ignoring invalid serviceNameLabel override", "value", o.ServiceName)
			}
		}
		if o.ServiceNamespace != "" {
			if validLabel.MatchString(o.ServiceNamespace) {
				app.otelCfg.Labels.ServiceNamespace = o.ServiceNamespace
				applied++
			} else {
				logger.Warn("Ignoring invalid serviceNamespaceLabel override", "value", o.ServiceNamespace)
			}
		}
		if o.DeploymentEnv != "" {
			if validLabel.MatchString(o.DeploymentEnv) {
				app.otelCfg.Labels.DeploymentEnv = o.DeploymentEnv
				applied++
			} else {
				logger.Warn("Ignoring invalid deploymentEnvLabel override", "value", o.DeploymentEnv)
			}
		}
		if applied > 0 {
			logger.Info("Label overrides applied", "count", applied, "labels", app.otelCfg.Labels)
		}
	}

	// Build reverse ingress alias lookup: service_name → []hostnames.
	// Normalize hostnames (lowercase, strip trailing dots, strip standard ports)
	// so they match the normalized addresses produced by extractTopologyNodeName.
	if len(app.settings.IngressAliases) > 0 {
		normalized := make(map[string]string, len(app.settings.IngressAliases))
		app.ingressByService = make(map[string][]string, len(app.settings.IngressAliases))
		for hostname, svcName := range app.settings.IngressAliases {
			if hostname == "" || svcName == "" {
				continue
			}
			h := normalizeAddress(hostname)
			svc := strings.TrimSpace(svcName)
			normalized[h] = svc
			app.ingressByService[svc] = append(app.ingressByService[svc], h)
		}
		app.settings.IngressAliases = normalized
		logger.Info("Ingress aliases configured", "count", len(normalized), "services", len(app.ingressByService))
	}

	// Read Grafana service account token from secureJsonData.
	// When deployed behind an OAuth2 proxy (e.g., Wonderwall/Nais), the browser's
	// session cookies are for the proxy, not for Grafana. Since the plugin backend
	// calls Grafana's datasource proxy API on localhost (bypassing the proxy),
	// we need a service account token to authenticate those internal API calls.
	if token, ok := settings.DecryptedSecureJSONData["serviceAccountToken"]; ok && token != "" {
		app.serviceToken = token
		logger.Info("Service account token configured for internal API calls")
	}

	// Build internal Grafana URL for datasource proxy calls.
	// The plugin runs in the same process/pod as Grafana, so always use localhost
	// for API callbacks. GF_APP_URL is the external URL and may not be reachable
	// from inside the pod (ingress, network policies, OAuth2 proxy, etc.).
	app.grafanaURL = resolveInternalGrafanaURL(logger)

	if uid := app.settings.MetricsDataSource.UID; uid != "" {
		proxyURL := fmt.Sprintf("%s/api/datasources/proxy/uid/%s", app.grafanaURL, uid)
		app.promClient = queries.NewPrometheusClient(proxyURL, app.serviceToken)
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

// Dispose is called when the plugin instance is shut down.
func (a *App) Dispose() {}

// ingressHostnames returns the configured ingress hostnames for a service, or nil.
func (a *App) ingressHostnames(service string) []string {
	if a.ingressByService == nil {
		return nil
	}
	return a.ingressByService[service]
}

// resolveInternalGrafanaURL builds the localhost URL for internal API calls.
// The plugin runs in the same process/pod as Grafana, so we always use localhost
// to avoid going through external ingress/load balancers/OAuth2 proxies.
// We preserve any sub-path from GF_APP_URL (for sub-path deployments).
func resolveInternalGrafanaURL(logger log.Logger) string {
	port := os.Getenv("GF_SERVER_HTTP_PORT")
	if port == "" {
		port = "3000"
	}
	base := "http://localhost:" + port

	// Preserve sub-path from GF_APP_URL if present (e.g., /grafana)
	if appURL := os.Getenv("GF_APP_URL"); appURL != "" {
		if u, err := url.Parse(appURL); err == nil && u.Path != "" && u.Path != "/" {
			base += strings.TrimRight(u.Path, "/")
		}
		logger.Info("Resolved internal Grafana URL", "internalURL", base, "GF_APP_URL", appURL)
	} else {
		logger.Info("Resolved internal Grafana URL", "internalURL", base, "GF_APP_URL", "(unset)")
	}

	return base
}

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

// callsMetric returns the detected span metrics calls metric name.
// Falls back to "traces_spanmetrics_calls_total" if not yet detected.
func (a *App) callsMetric(ctx context.Context) string {
	caps := a.cachedOrDetectCapabilities(ctx)
	if caps.SpanMetrics.CallsMetric != "" {
		return caps.SpanMetrics.CallsMetric
	}
	return "traces_spanmetrics_calls_total"
}

// promClientForRequest returns a PrometheusClient with auth resolved for the request.
// Auth priority: 1) auto-managed SA token (via IAM/externalServiceAccounts),
// 2) manual SA token (from secureJsonData), 3) forwarded user headers.
func (a *App) promClientForRequest(r *http.Request) *queries.PrometheusClient {
	if a.promClient == nil {
		return nil
	}

	// Try auto-managed service account token from Grafana (zero-config)
	if token := a.resolveServiceToken(r.Context()); token != "" {
		return a.promClient.WithServiceToken(token).WithAuthHeaders(r.Header)
	}

	return a.promClient.WithAuthHeaders(r.Header)
}

// resolveServiceToken returns the best available service account token.
// Prefers the auto-managed token from Grafana's externalServiceAccounts
// feature (PluginAppClientSecret), then falls back to the manual token
// from secureJsonData.
func (a *App) resolveServiceToken(ctx context.Context) string {
	cfg := backend.GrafanaConfigFromContext(ctx)
	if cfg != nil {
		if token, err := cfg.PluginAppClientSecret(); err == nil && token != "" {
			return token
		}
	}
	return a.serviceToken
}

// requestContext builds a context with both auth-enhanced PrometheusClient and raw HTTP
// headers stored. This ensures that downstream code (capability detection, health checks)
// can access both the prom client and the user's auth headers.
func (a *App) requestContext(req *http.Request) context.Context {
	ctx := req.Context()
	ctx = withAuthContext(ctx, a.promClientForRequest(req))
	ctx = context.WithValue(ctx, httpHeadersCtxKey{}, req.Header.Clone())
	return ctx
}

// Context key for per-request PrometheusClient with forwarded auth.
type promClientCtxKey struct{}

// Context key for raw HTTP headers (used by health checks).
type httpHeadersCtxKey struct{}

// withAuthContext stores an auth-enhanced PrometheusClient in the context.
func withAuthContext(ctx context.Context, c *queries.PrometheusClient) context.Context {
	return context.WithValue(ctx, promClientCtxKey{}, c)
}

// httpHeaders returns the stored HTTP headers from context, or an empty header.
func httpHeaders(ctx context.Context) http.Header {
	if h, ok := ctx.Value(httpHeadersCtxKey{}).(http.Header); ok && h != nil {
		return h
	}
	return http.Header{}
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

	// Resolve the best available service token
	token := a.resolveServiceToken(ctx)

	if a.promClient != nil {
		client := a.promClient.WithAuthHeaders(h)
		if token != "" {
			client = client.WithServiceToken(token)
		}
		ctx = withAuthContext(ctx, client)
	}

	caps := a.detectCapabilities(ctx, h, token)

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
	mux.HandleFunc("/services/{namespace}/{service}/health", a.handleHealth)
	mux.HandleFunc("/services/{namespace}/{service}/operations", a.handleOperations)
	mux.HandleFunc("/services/{namespace}/{service}/endpoints", a.handleEndpoints)
	mux.HandleFunc("/services/{namespace}/{service}/frontend", a.handleFrontendMetrics)
	mux.HandleFunc("/services/{namespace}/{service}/dependencies", a.handleServiceDependencies)
	mux.HandleFunc("/services/{namespace}/{service}/connected", a.handleConnectedServices)
	mux.HandleFunc("/services/{namespace}/{service}/graphql", a.handleGraphQLMetrics)
	mux.HandleFunc("/services/{namespace}/{service}/runtime", a.handleRuntime)
	mux.HandleFunc("/service-map", a.handleServiceMap)
	mux.HandleFunc("/dependencies", a.handleGlobalDependencies)
	mux.HandleFunc("/dependencies/{name}", a.handleDependencyDetail)
	mux.HandleFunc("/namespaces/{namespace}/dependencies", a.handleNamespaceDependencies)
	mux.HandleFunc("/namespaces/{namespace}/alerts", a.handleNamespaceAlerts)
	mux.HandleFunc("/ping", a.handlePing)
}
