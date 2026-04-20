package queries

// DataSourceRef identifies a Grafana datasource.
type DataSourceRef struct {
	UID  string `json:"uid"`
	Type string `json:"type"`
}

// EnvAwareDataSource holds a default datasource UID plus optional per-environment overrides.
type EnvAwareDataSource struct {
	UID           string                   `json:"uid"`
	Type          string                   `json:"type"`
	ByEnvironment map[string]DataSourceRef `json:"byEnvironment,omitempty"`
}

// Resolve returns the datasource ref for a given environment.
// Falls back to the default UID/Type when the environment has no override.
func (e EnvAwareDataSource) Resolve(env string) DataSourceRef {
	if env != "" {
		if ds, ok := e.ByEnvironment[env]; ok && ds.UID != "" {
			return ds
		}
	}
	return DataSourceRef{UID: e.UID, Type: e.Type}
}

// HasEnvironment returns true if an override exists for the given environment.
func (e EnvAwareDataSource) HasEnvironment(env string) bool {
	if env == "" {
		return true // default always "exists"
	}
	_, ok := e.ByEnvironment[env]
	return ok
}

// PluginSettings holds parsed jsonData from the app plugin configuration.
type PluginSettings struct {
	MetricsDataSource DataSourceRef      `json:"metricsDataSource"`
	TracesDataSource  EnvAwareDataSource `json:"tracesDataSource"`
	LogsDataSource    EnvAwareDataSource `json:"logsDataSource"`

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

	// Per-environment datasource availability
	TempoByEnv map[string]DataSourceStatus `json:"tempoByEnv,omitempty"`
	LokiByEnv  map[string]DataSourceStatus `json:"lokiByEnv,omitempty"`
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
	Framework       string       `json:"framework,omitempty"`
	HasFrontend     bool         `json:"hasFrontend,omitempty"`
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

// DependencyOperation represents an operation calling a specific dependency,
// grouped by span name and calling service.
type DependencyOperation struct {
	SpanName       string  `json:"spanName"`
	CallingService string  `json:"callingService"`
	Rate           float64 `json:"rate"`
	ErrorRate      float64 `json:"errorRate"`
	P95Duration    float64 `json:"p95Duration"`
	DurationUnit   string  `json:"durationUnit"`
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

	// Messaging-specific (Consumer/Producer)
	MessagingKind string `json:"messagingKind,omitempty"`
}

// EndpointGroups is the grouped endpoint response for the Server tab.
type EndpointGroups struct {
	HTTP         []EndpointSummary `json:"http"`
	GRPC         []EndpointSummary `json:"grpc"`
	Database     []EndpointSummary `json:"database"`
	Messaging    []EndpointSummary `json:"messaging"`
	Internal     []EndpointSummary `json:"internal"`
	DurationUnit string            `json:"durationUnit"`
}

// ---------------------------------------------------------------------------
// Runtime metrics — JVM, Node.js, DB pools, Kafka
// ---------------------------------------------------------------------------

// RuntimeResponse is the top-level response for the Runtime tab.
type RuntimeResponse struct {
	JVM    *JVMRuntime    `json:"jvm,omitempty"`
	NodeJS *NodeJSRuntime `json:"nodejs,omitempty"`
	DBPool *DBPoolRuntime `json:"dbPool,omitempty"`
	Kafka  *KafkaRuntime  `json:"kafka,omitempty"`
}

// DetectionStatus indicates whether a metric category was found.
type DetectionStatus string

const (
	StatusDetected   DetectionStatus = "detected"
	StatusAbsent     DetectionStatus = "absent"
	StatusError      DetectionStatus = "error"
)

// JVMRuntime holds JVM runtime metrics for a service.
type JVMRuntime struct {
	Status         DetectionStatus  `json:"status"`
	HeapUsed       float64          `json:"heapUsed"`       // bytes, avg across pods
	HeapMax        float64          `json:"heapMax"`         // bytes, max across pods
	HeapCommitted  float64          `json:"heapCommitted"`   // bytes, avg across pods
	NonHeapUsed    float64          `json:"nonHeapUsed"`     // bytes, avg across pods
	GCPauseRate    float64          `json:"gcPauseRate"`     // pauses/sec, sum across pods
	GCPauseAvg     float64          `json:"gcPauseAvg"`      // seconds, avg pause duration
	GCOverhead     float64          `json:"gcOverhead"`      // 0-1, ratio of time in GC
	ThreadsLive    float64          `json:"threadsLive"`     // avg across pods
	ThreadsDaemon  float64          `json:"threadsDaemon"`   // avg across pods
	ThreadsPeak    float64          `json:"threadsPeak"`     // max across pods
	ThreadStates   map[string]int   `json:"threadStates,omitempty"` // state → count
	ClassesLoaded  float64          `json:"classesLoaded"`   // avg across pods
	CPUUtilization float64          `json:"cpuUtilization"`  // 0-1, recent CPU ratio
	CPUCount       int              `json:"cpuCount"`        // number of CPUs
	Uptime         float64          `json:"uptime"`          // seconds, min across pods
	BufferUsed     float64          `json:"bufferUsed"`      // bytes, buffer pool usage
	BufferCapacity float64          `json:"bufferCapacity"`  // bytes, buffer pool capacity
	Versions       []RuntimeVersion `json:"versions,omitempty"`
	PodCount       int              `json:"podCount"`
}

// RuntimeVersion describes a JVM or Node.js version in use.
type RuntimeVersion struct {
	Version string `json:"version"`
	Runtime string `json:"runtime,omitempty"`
	Count   int    `json:"count"` // number of pods
}

// NodeJSRuntime holds Node.js runtime metrics for a service.
type NodeJSRuntime struct {
	Status              DetectionStatus  `json:"status"`
	EventLoopP99        float64          `json:"eventLoopP99"`        // seconds, max across pods
	EventLoopP90        float64          `json:"eventLoopP90"`        // seconds, max across pods
	EventLoopP50        float64          `json:"eventLoopP50"`        // seconds, avg across pods
	EventLoopMean       float64          `json:"eventLoopMean"`       // seconds, avg across pods
	EventLoopUtil       float64          `json:"eventLoopUtil"`       // 0-1, utilization ratio
	HeapUsed            float64          `json:"heapUsed"`            // bytes, avg across pods
	HeapTotal           float64          `json:"heapTotal"`           // bytes, avg across pods
	ExternalMem         float64          `json:"externalMem"`         // bytes, avg across pods
	RSS                 float64          `json:"rss"`                 // bytes, avg across pods
	GCRate              float64          `json:"gcRate"`              // GC runs/sec, sum across pods
	ActiveHandles       float64          `json:"activeHandles"`       // avg across pods
	ActiveRequests      float64          `json:"activeRequests"`      // avg across pods
	CPUUsage            float64          `json:"cpuUsage"`            // CPU seconds/sec (rate)
	OpenFDs             float64          `json:"openFds"`             // avg across pods
	MaxFDs              float64          `json:"maxFds"`              // max FDs allowed
	Versions            []RuntimeVersion `json:"versions,omitempty"`
	PodCount            int              `json:"podCount"`
}

// DBPoolRuntime holds database connection pool metrics.
type DBPoolRuntime struct {
	Status DetectionStatus `json:"status"`
	Pools  []DBPool        `json:"pools"`
}

// DBPool is a single database connection pool.
type DBPool struct {
	Name        string  `json:"name"`
	Type        string  `json:"type"`        // "hikaricp" or "otel"
	Active      float64 `json:"active"`      // sum across pods
	Idle        float64 `json:"idle"`        // sum across pods
	Max         float64 `json:"max"`         // max across pods (pool config is same)
	Pending     float64 `json:"pending"`     // sum across pods — threads waiting
	TimeoutRate float64 `json:"timeoutRate"` // timeouts/sec
	Utilization float64 `json:"utilization"` // active/max as percentage
}

// KafkaRuntime holds Kafka client metrics.
type KafkaRuntime struct {
	Status DetectionStatus `json:"status"`
	Topics []KafkaTopic    `json:"topics"`
}

// KafkaTopic is lag/throughput for a single Kafka topic.
type KafkaTopic struct {
	Topic       string  `json:"topic"`
	MaxLag      float64 `json:"maxLag"`      // max lag across partitions
	Partitions  int     `json:"partitions"`   // number of partitions seen
	ConsumeRate float64 `json:"consumeRate"` // records/sec
}
