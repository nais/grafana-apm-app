package plugin

import "github.com/nais/grafana-otel-plugin/pkg/plugin/queries"

// ---------------------------------------------------------------------------
// API response models — dependency endpoints
// ---------------------------------------------------------------------------

// DependencySummary represents an external dependency (DB, cache, API).
type DependencySummary struct {
	Name         string  `json:"name"`
	DisplayName  string  `json:"displayName,omitempty"`
	Type         string  `json:"type"`
	Rate         float64 `json:"rate"`
	ErrorRate    float64 `json:"errorRate"`
	P95Duration  float64 `json:"p95Duration"`
	DurationUnit string  `json:"durationUnit"`
	Impact       float64 `json:"impact"`
}

// DependenciesResponse wraps a list of dependencies.
type DependenciesResponse struct {
	Dependencies []DependencySummary `json:"dependencies"`
}

// NamespaceDependency represents an external dependency seen from a namespace,
// with the number of services within the namespace that call it.
type NamespaceDependency struct {
	Name         string  `json:"name"`
	DisplayName  string  `json:"displayName,omitempty"`
	Type         string  `json:"type"`
	CallerCount  int     `json:"callerCount"`
	Rate         float64 `json:"rate"`
	ErrorRate    float64 `json:"errorRate"`
	P95Duration  float64 `json:"p95Duration"`
	DurationUnit string  `json:"durationUnit"`
}

// NamespaceDependenciesResponse wraps namespace-scoped dependencies.
type NamespaceDependenciesResponse struct {
	Dependencies []NamespaceDependency `json:"dependencies"`
}

// DependencyDetailResponse contains dependency info plus upstream callers and operations.
type DependencyDetailResponse struct {
	Dependency DependencySummary             `json:"dependency"`
	Upstreams  []DependencySummary           `json:"upstreams"`
	Operations []queries.DependencyOperation `json:"operations"`
}

// ConnectedService represents a service connected via service graph.
type ConnectedService struct {
	Name           string  `json:"name"`
	ConnectionType string  `json:"connectionType,omitempty"`
	IsSidecar      bool    `json:"isSidecar,omitempty"`
	Rate           float64 `json:"rate"`
	ErrorRate      float64 `json:"errorRate"`
	P95Duration    float64 `json:"p95Duration"`
	DurationUnit   string  `json:"durationUnit"`
}

// ConnectedServicesResponse contains inbound and outbound service connections.
type ConnectedServicesResponse struct {
	Inbound  []ConnectedService `json:"inbound"`
	Outbound []ConnectedService `json:"outbound"`
}

// ---------------------------------------------------------------------------
// API response models — GraphQL endpoints
// ---------------------------------------------------------------------------

// GraphQLOperation is a single GraphQL operation or resolver.
type GraphQLOperation struct {
	Name        string   `json:"name"`
	Type        string   `json:"type,omitempty"` // query, mutation, or empty
	Rate        float64  `json:"rate"`
	ErrorRate   *float64 `json:"errorRate"`   // nil when not computable
	AvgLatency  float64  `json:"avgLatency"`  // average latency in latencyUnit
	LatencyUnit string   `json:"latencyUnit"` // "s" or "ms"
}

// GraphQLMetricsResponse is the API response for GraphQL metrics.
type GraphQLMetricsResponse struct {
	Detected   bool               `json:"detected"`
	Framework  string             `json:"framework,omitempty"`
	Operations []GraphQLOperation `json:"operations,omitempty"`
	Fetchers   []GraphQLOperation `json:"fetchers,omitempty"` // DGS datafetchers
}

// ---------------------------------------------------------------------------
// API response models — frontend/Faro endpoints
// ---------------------------------------------------------------------------

// FrontendMetricsResponse contains browser/Faro metrics for a service.
type FrontendMetricsResponse struct {
	Available bool               `json:"available"`
	Source    string             `json:"source,omitempty"` // "mimir", "loki", "alloy", or "alloy-histogram"
	Vitals    map[string]float64 `json:"vitals,omitempty"`
	ErrorRate float64            `json:"errorRate"`
	// Capabilities for hybrid rendering — when set, frontend uses both
	// metrics and Loki datasources for the richest possible view.
	MetricsSource string `json:"metricsSource,omitempty"` // "mimir", "alloy-histogram", "alloy", or ""
	HasLoki       bool   `json:"hasLoki,omitempty"`       // true if Loki has Faro data for this service
}

// ---------------------------------------------------------------------------
// API response models — service map endpoints
// ---------------------------------------------------------------------------

// ServiceMapNode represents a node in the service map.
type ServiceMapNode struct {
	ID            string  `json:"id"`
	Title         string  `json:"title"`
	SubTitle      string  `json:"subtitle,omitempty"`
	MainStat      string  `json:"mainStat,omitempty"`
	SecondaryStat string  `json:"secondaryStat,omitempty"`
	ArcErrors     float64 `json:"arc__errors"` //nolint:revive // JSON field required by Grafana node graph
	ArcOK         float64 `json:"arc__ok"`     //nolint:revive // JSON field required by Grafana node graph
	NodeType      string  `json:"nodeType,omitempty"`
	IsSidecar     bool    `json:"isSidecar,omitempty"`
	ErrorRate     float64 `json:"errorRate"`
}

// ServiceMapEdge represents an edge between two services.
type ServiceMapEdge struct {
	ID            string  `json:"id"`
	Source        string  `json:"source"`
	Target        string  `json:"target"`
	MainStat      string  `json:"mainStat,omitempty"`
	SecondaryStat string  `json:"secondaryStat,omitempty"`
}

// ServiceMapResponse is the full service map graph.
type ServiceMapResponse struct {
	Nodes []ServiceMapNode `json:"nodes"`
	Edges []ServiceMapEdge `json:"edges"`
}

// ---------------------------------------------------------------------------
// API response models — alert endpoints
// ---------------------------------------------------------------------------

// AlertRuleSummary is a simplified alert rule for the namespace page.
type AlertRuleSummary struct {
	Name        string `json:"name"`
	State       string `json:"state"`       // "firing", "pending", "inactive"
	Severity    string `json:"severity"`    // from labels.severity
	Summary     string `json:"summary"`     // from annotations.summary
	Description string `json:"description"` // from annotations.description
	ActiveSince string `json:"activeSince,omitempty"`
	ActiveCount int    `json:"activeCount"`
	GroupName   string `json:"groupName"`
}

// NamespaceAlertsResponse wraps alert rules for a namespace.
type NamespaceAlertsResponse struct {
	Rules        []AlertRuleSummary `json:"rules"`
	Unavailable  bool               `json:"unavailable,omitempty"`
	ErrorMessage string             `json:"errorMessage,omitempty"`
}
