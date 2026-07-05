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
	Source    string             `json:"source,omitempty"` // "alloy-histogram"
	Vitals    map[string]float64 `json:"vitals,omitempty"`
	ErrorRate float64            `json:"errorRate"`
	HasLoki   bool               `json:"hasLoki,omitempty"` // true if Loki has Faro data for enrichment panels
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
	IsHub         bool    `json:"isHub,omitempty"`
	HubDegree     int     `json:"hubDegree,omitempty"`
	CallerCount   int     `json:"callerCount,omitempty"`
	ErrorRate     float64 `json:"errorRate"`
	// ServiceCount is the number of distinct services a clustered (namespace)
	// node represents. Zero/omitted for ordinary service-level nodes.
	ServiceCount int `json:"serviceCount,omitempty"`
}

// ServiceMapEdge represents an edge between two services.
type ServiceMapEdge struct {
	ID            string `json:"id"`
	Source        string `json:"source"`
	Target        string `json:"target"`
	MainStat      string `json:"mainStat,omitempty"`
	SecondaryStat string `json:"secondaryStat,omitempty"`
}

// ServiceMapResponse is the full service map graph.
type ServiceMapResponse struct {
	Nodes []ServiceMapNode `json:"nodes"`
	Edges []ServiceMapEdge `json:"edges"`
}

// ---------------------------------------------------------------------------
// API response models — alert endpoints
// ---------------------------------------------------------------------------

// AlertInstance is one active (firing/pending) instance of an alert rule: the
// concrete label set that matched and the value that tripped the threshold,
// straight from the Prometheus-compatible rules API's inline alerts[] (#33).
// The list is capped per rule (alertInstanceCap) to bound the payload, with
// AlertRuleSummary.InstancesTruncated flagging when instances were dropped.
type AlertInstance struct {
	State    string            `json:"state"` // "firing" or "pending"
	Value    string            `json:"value,omitempty"`
	ActiveAt string            `json:"activeAt,omitempty"`
	Labels   map[string]string `json:"labels,omitempty"`
}

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
	Source      string `json:"source,omitempty"` // "mimir" (ruler) or "grafana" (unified alerting)
	// Expression is the rule's raw PromQL/LogQL query, surfaced for the #32
	// firing-alert drawer's collapsible condition block. Empty when the ruler
	// omits it.
	Expression string `json:"expression,omitempty"`
	// ForDuration is the rule's `for` window in seconds (how long the condition
	// must hold before firing) — the evaluation window shown in the drawer.
	ForDuration float64 `json:"forDuration,omitempty"`
	// RunbookURL is the standard runbook_url annotation, surfaced verbatim as a
	// button in the drawer (#32). Empty when the rule sets no runbook.
	RunbookURL string `json:"runbookUrl,omitempty"`
	// Instances carries the per-instance firing detail (value vs threshold,
	// matched labels) for the active alerts, capped at alertInstanceCap (#33).
	Instances []AlertInstance `json:"instances,omitempty"`
	// InstancesTruncated is true when more than alertInstanceCap instances were
	// active and the surplus was dropped from Instances.
	InstancesTruncated bool `json:"instancesTruncated,omitempty"`
}

// NamespaceAlertsResponse wraps alert rules for a namespace.
type NamespaceAlertsResponse struct {
	Rules        []AlertRuleSummary `json:"rules"`
	Unavailable  bool               `json:"unavailable,omitempty"`
	ErrorMessage string             `json:"errorMessage,omitempty"`
}

// ServiceAlertsResponse wraps the alert rules that mention a single service —
// the service-scoped sibling of NamespaceAlertsResponse and the payload of the
// Alerts tab's rule list. Each rule now carries its read-only firing state and
// active instances inline (#33); the #32 firing-alert detail drawer layers over
// this list as a follow-up.
type ServiceAlertsResponse struct {
	Rules        []AlertRuleSummary `json:"rules"`
	Unavailable  bool               `json:"unavailable,omitempty"`
	ErrorMessage string             `json:"errorMessage,omitempty"`
}
