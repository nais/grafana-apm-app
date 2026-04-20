package queries

// DataSourceRef identifies a Grafana datasource.
type DataSourceRef struct {
	UID  string `json:"uid"`
	Type string `json:"type"`
}

// PluginSettings holds parsed jsonData from the app plugin configuration.
type PluginSettings struct {
	MetricsDataSource DataSourceRef `json:"metricsDataSource"`
	TracesDataSource  DataSourceRef `json:"tracesDataSource"`
	LogsDataSource    DataSourceRef `json:"logsDataSource"`

	// Optional overrides (auto-detected if empty)
	MetricNamespace string `json:"metricNamespace,omitempty"`
	DurationUnit    string `json:"durationUnit,omitempty"`
}

// Capabilities represents the detected OTel data capabilities.
type Capabilities struct {
	SpanMetrics  SpanMetricsCapability  `json:"spanMetrics"`
	ServiceGraph ServiceGraphCapability `json:"serviceGraph"`
	Tempo        DataSourceStatus       `json:"tempo"`
	Loki         DataSourceStatus       `json:"loki"`
	Services     []string               `json:"services"`
}

// SpanMetricsCapability describes detected span metrics configuration.
type SpanMetricsCapability struct {
	Detected       bool   `json:"detected"`
	Namespace      string `json:"namespace,omitempty"`
	CallsMetric    string `json:"callsMetric,omitempty"`
	DurationMetric string `json:"durationMetric,omitempty"`
	DurationUnit   string `json:"durationUnit,omitempty"`
}

// ServiceGraphCapability describes detected service graph metrics.
type ServiceGraphCapability struct {
	Detected bool   `json:"detected"`
	Prefix   string `json:"prefix,omitempty"` // e.g. "traces_service_graph" or "service_graph"
}

// DataSourceStatus describes whether a datasource is reachable.
type DataSourceStatus struct {
	Available bool   `json:"available"`
	Error     string `json:"error,omitempty"`
}

// ServiceSummary is a single service entry for the inventory page.
type ServiceSummary struct {
	Name            string       `json:"name"`
	Namespace       string       `json:"namespace"`
	Environment     string       `json:"environment,omitempty"`
	SDKLanguage     string       `json:"sdkLanguage,omitempty"`
	Rate            float64      `json:"rate"`
	ErrorRate       float64      `json:"errorRate"`
	P95Duration     float64      `json:"p95Duration"`
	DurationUnit    string       `json:"durationUnit"`
	RateSeries      []DataPoint  `json:"rateSeries,omitempty"`
	DurationSeries  []DataPoint  `json:"durationSeries,omitempty"`
}

// DataPoint is a timestamp-value pair for sparkline charts.
type DataPoint struct {
	Timestamp int64   `json:"t"`
	Value     float64 `json:"v"`
}

// OperationSummary is a single operation entry for the operations table.
type OperationSummary struct {
	SpanName     string  `json:"spanName"`
	SpanKind     string  `json:"spanKind"`
	Rate         float64 `json:"rate"`
	ErrorRate    float64 `json:"errorRate"`
	P50Duration  float64 `json:"p50Duration"`
	P95Duration  float64 `json:"p95Duration"`
	P99Duration  float64 `json:"p99Duration"`
	DurationUnit string  `json:"durationUnit"`
}

// EndpointSummary represents a single API endpoint or operation with protocol metadata.
type EndpointSummary struct {
	SpanName     string  `json:"spanName"`
	Rate         float64 `json:"rate"`
	ErrorRate    float64 `json:"errorRate"`
	P50Duration  float64 `json:"p50Duration"`
	P95Duration  float64 `json:"p95Duration"`
	P99Duration  float64 `json:"p99Duration"`
	DurationUnit string  `json:"durationUnit"`

	// HTTP-specific
	HTTPMethod string `json:"httpMethod,omitempty"`
	HTTPRoute  string `json:"httpRoute,omitempty"`

	// gRPC-specific
	RPCService string `json:"rpcService,omitempty"`
	RPCMethod  string `json:"rpcMethod,omitempty"`

	// Database-specific
	DBSystem string `json:"dbSystem,omitempty"`
}

// EndpointGroups is the grouped endpoint response for the Server tab.
type EndpointGroups struct {
	HTTP         []EndpointSummary `json:"http"`
	GRPC         []EndpointSummary `json:"grpc"`
	Database     []EndpointSummary `json:"database"`
	Internal     []EndpointSummary `json:"internal"`
	DurationUnit string            `json:"durationUnit"`
}
