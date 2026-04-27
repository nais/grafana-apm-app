// Package otelconfig centralises every OpenTelemetry metric name, label
// name, enum value, and browser-metric name that the plugin references.
//
// Nothing in this package is user-facing today, but the struct-based design
// means we can make any field overridable via plugin settings later without
// a scatter-shot refactor.
package otelconfig

import "fmt"

// ---------------------------------------------------------------------------
// Labels — Prometheus label names produced by OTel span-metrics pipelines.
// ---------------------------------------------------------------------------

// Labels defines Prometheus label names produced by OTel span-metrics pipelines.
type Labels struct {
	ServiceName      string
	ServiceNamespace string
	SpanName         string
	SpanKind         string
	StatusCode       string

	// HTTP semantic conventions
	HTTPMethod     string
	HTTPRoute      string
	HTTPStatusCode string

	// gRPC
	RPCService string
	RPCMethod  string

	// Database
	DBSystem    string
	DBName      string
	DBOperation string

	// Messaging
	MessagingSystem      string
	MessagingDestination string

	// Network / peer
	ServerAddress string
	HTTPHost      string

	// Resource / deployment
	DeploymentEnv string
	SDKLanguage   string

	// Histogram bucket boundary
	Le string

	// Service-graph specific
	Client         string
	Server         string
	ConnectionType string
}

// ---------------------------------------------------------------------------
// Enum values — span_kind and status_code values written by OTel SDKs.
// ---------------------------------------------------------------------------

// SpanKinds maps semantic span kinds to their OTel string values.
type SpanKinds struct {
	Server   string
	Client   string
	Producer string
	Consumer string
	Internal string
}

// StatusCodes maps semantic status codes to their OTel string values.
type StatusCodes struct {
	Error string
	OK    string
	Unset string
}

// ---------------------------------------------------------------------------
// TraceQL — attribute paths used when building Tempo TraceQL queries.
// ---------------------------------------------------------------------------

// TraceQL defines attribute paths for Tempo TraceQL queries.
type TraceQL struct {
	ServiceName      string
	ServiceNamespace string
}

// ---------------------------------------------------------------------------
// Browser / Faro metrics
// ---------------------------------------------------------------------------

// BrowserMetrics defines Prometheus metric names for browser/Faro Web Vitals.
type BrowserMetrics struct {
	LCP              string
	FCP              string
	CLS              string
	INP              string
	TTFB             string
	PageLoads        string
	Errors           string
	PageLoadDuration string
	PageRoute        string
	BrowserName      string
}

// AlloyBrowserMetrics defines metric names for Faro telemetry processed by
// the Grafana Alloy pipeline. Alloy produces metrics with a
// "loki_process_custom_" prefix and uses "app_name" as the service identifier.
type AlloyBrowserMetrics struct {
	LCP       string
	FCP       string
	CLS       string
	INP       string
	TTFB      string
	PageLoads string
	Errors    string
	AppLabel  string
	Job       string // job label for detection (e.g. "alloy-faro")
	Lookback  string // lookback window for sparse gauges (e.g. "30m")
}

// ---------------------------------------------------------------------------
// FaroLoki — field names for Faro telemetry stored as structured logs in Loki.
// Some environments (e.g. Nav) store Faro data as logfmt lines in Loki
// rather than as Prometheus metrics.
// ---------------------------------------------------------------------------

// FaroLoki defines field names for Faro telemetry stored in Loki.
type FaroLoki struct {
	// Stream labels
	ServiceName string
	Kind        string
	AppName     string

	// kind= values
	KindMeasurement string
	KindException   string
	KindEvent       string
	KindLog         string

	// logfmt field names
	TypeField     string
	TypeWebVitals string

	// Vital field names in logfmt
	FCP  string
	LCP  string
	CLS  string
	INP  string
	TTFB string

	// Context fields
	Rating      string
	BrowserName string
	PageURL     string
}

// ---------------------------------------------------------------------------
// ServiceGraph — metric suffixes appended to the detected prefix.
// ---------------------------------------------------------------------------

// ServiceGraph defines metric suffixes appended to the detected prefix.
type ServiceGraph struct {
	RequestTotal        string
	RequestFailedTotal  string
	RequestServerBucket string
}

// ---------------------------------------------------------------------------
// Runtime metrics — app-emitted metrics from JVM, Node.js, DB pools, Kafka.
// These use `app`/`namespace` labels (Prometheus scraping), NOT the
// `service_name`/`service_namespace` from OTel span metrics.
// ---------------------------------------------------------------------------

// RuntimeLabels defines the label names used by app-emitted metrics.
type RuntimeLabels struct {
	App       string // "app"
	Namespace string // "namespace"
}

// JVMMetrics defines metric names for Java/Kotlin runtime observability.
type JVMMetrics struct {
	MemoryUsed      string // jvm_memory_used_bytes — gauge, group by area
	MemoryMax       string // jvm_memory_max_bytes — gauge, group by area
	MemoryCommitted string // jvm_memory_committed_bytes — gauge, group by area
	GCDuration      string // jvm_gc_duration_seconds — histogram
	GCOverhead      string // jvm_gc_overhead — gauge (0-1)
	ThreadsLive     string // jvm_threads_live_threads — gauge
	ThreadsDaemon   string // jvm_threads_daemon_threads — gauge
	ThreadsPeak     string // jvm_threads_peak_threads — gauge
	ThreadsStates   string // jvm_threads_states_threads — gauge by state
	ClassesLoaded   string // jvm_classes_loaded_classes — gauge
	CPUUtilization  string // jvm_cpu_recent_utilization_ratio — gauge (0-1)
	CPUCount        string // jvm_cpu_count — gauge
	Uptime          string // process_uptime_seconds — gauge
	BufferUsed      string // jvm_buffer_memory_used_bytes — gauge
	BufferCapacity  string // jvm_buffer_total_capacity_bytes — gauge
	Info            string // jvm_info — gauge (info metric)
	AreaLabel       string // "area" — heap / nonheap
	GCLabel         string // "gc" — G1 Young / G1 Old / etc
	IDLabel         string // "id" — memory pool name
	StateLabel      string // "state" — thread state
}

// NodeJSMetrics defines metric names for Node.js runtime observability.
type NodeJSMetrics struct {
	EventLoopP99   string // nodejs_eventloop_delay_p99_seconds — gauge
	EventLoopP90   string // nodejs_eventloop_delay_p90_seconds — gauge
	EventLoopP50   string // nodejs_eventloop_delay_p50_seconds — gauge
	EventLoopMean  string // nodejs_eventloop_delay_mean_seconds — gauge
	EventLoopUtil  string // nodejs_eventloop_utilization_ratio — gauge (0-1)
	HeapUsed       string // nodejs_heap_size_used_bytes — gauge
	HeapTotal      string // nodejs_heap_size_total_bytes — gauge
	ExternalMem    string // nodejs_external_memory_bytes — gauge
	RSS            string // process_resident_memory_bytes — gauge
	GCDuration     string // nodejs_gc_duration_seconds — histogram
	ActiveHandles  string // nodejs_active_handles — gauge
	ActiveRequests string // nodejs_active_requests — gauge
	CPUTotal       string // process_cpu_seconds_total — counter
	OpenFDs        string // process_open_fds — gauge
	MaxFDs         string // process_max_fds — gauge
	VersionInfo    string // nodejs_version_info — gauge (info metric)
	KindLabel      string // "kind" — for GC type (scavenge, mark_sweep_compact)
}

// DBPoolMetrics defines metric names for database connection pools.
type DBPoolMetrics struct {
	// HikariCP (Spring Boot / Ktor)
	HikariActive  string // hikaricp_connections_active — gauge per pool
	HikariIdle    string // hikaricp_connections_idle — gauge per pool
	HikariMax     string // hikaricp_connections_max — gauge per pool
	HikariPending string // hikaricp_connections_pending — gauge per pool
	HikariTimeout string // hikaricp_connections_timeout_total — counter
	HikariUsage   string // hikaricp_connections_usage_seconds — histogram

	// OTel DB client connections (newer instrumentation)
	OtelDBActive string // db_client_connections_usage — gauge
	OtelDBIdle   string // db_client_connections_idle_min — gauge
	OtelDBMax    string // db_client_connections_max — gauge

	PoolLabel string // "pool" — pool name
}

// KafkaMetrics defines metric names for Kafka client observability.
type KafkaMetrics struct {
	ConsumerLagMax      string // kafka_consumer_records_lag_max — gauge
	ConsumerConsumed    string // kafka_consumer_records_consumed_total — counter
	ProducerSent        string // kafka_producer_records_sent_total — counter (if available)
	TopicLabel          string // "topic"
	PartitionLabel      string // "partition"
	ClientIDLabel       string // "client_id"
	ConsumerGroupLabel  string // "consumer_group" (if available)
}

// ContainerMetrics defines metric names for Kubernetes container resource metrics.
type ContainerMetrics struct {
	CPUUsage        string // container_cpu_usage_seconds_total — counter
	CPUThrottled    string // container_cpu_cfs_throttled_seconds_total — counter
	MemoryUsage     string // container_memory_usage_bytes — gauge
	ResourceReqs    string // kube_pod_container_resource_requests — gauge (resource label)
	ResourceLimits  string // kube_pod_container_resource_limits — gauge (resource label)
	Restarts        string // kube_pod_container_status_restarts_total — counter
	DesiredReplicas string // kube_deployment_spec_replicas — gauge
	ContainerLabel  string // "container"
	ResourceLabel   string // "resource"
}

// GoMetrics defines metric names for Go runtime observability.
type GoMetrics struct {
	Goroutines  string // go_goroutines — gauge
	Threads     string // go_threads — gauge
	MemAlloc    string // go_memstats_alloc_bytes — gauge
	MemSys      string // go_memstats_sys_bytes — gauge
	GCDuration  string // go_gc_duration_seconds — summary
	CPUTotal    string // process_cpu_seconds_total — counter (shared with Node.js)
	OpenFDs     string // process_open_fds — gauge
	MaxFDs      string // process_max_fds — gauge
	Info        string // go_info — info metric with version label
}

// RuntimeMetrics groups all runtime metric naming conventions.
type RuntimeMetrics struct {
	Labels    RuntimeLabels
	JVM       JVMMetrics
	NodeJS    NodeJSMetrics
	Go        GoMetrics
	DBPool    DBPoolMetrics
	Kafka     KafkaMetrics
	Container ContainerMetrics
}

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

// Config groups every naming convention the plugin relies on.  Create one
// via Default() and store it on the App struct.  All query-building code
// should reference fields on this struct rather than using string literals.
type Config struct {
	Labels              Labels
	SpanKinds           SpanKinds
	StatusCodes         StatusCodes
	TraceQL             TraceQL
	BrowserMetrics      BrowserMetrics
	AlloyBrowserMetrics AlloyBrowserMetrics
	FaroLoki            FaroLoki
	ServiceGraph        ServiceGraph
	Runtime             RuntimeMetrics
}

// Default returns the standard OTel + Grafana Faro naming conventions.
func Default() Config {
	return Config{
		Labels: Labels{
			ServiceName:      "service_name",
			ServiceNamespace: "service_namespace",
			SpanName:         "span_name",
			SpanKind:         "span_kind",
			StatusCode:       "status_code",

			HTTPMethod:     "http_method",
			HTTPRoute:      "http_route",
			HTTPStatusCode: "http_response_status_code",

			RPCService: "rpc_service",
			RPCMethod:  "rpc_method",

			DBSystem:    "db_system",
			DBName:      "db_name",
			DBOperation: "db_operation",

			MessagingSystem:      "messaging_system",
			MessagingDestination: "messaging_destination_name",

			ServerAddress: "server_address",
			HTTPHost:      "http_host",

			DeploymentEnv: "k8s_cluster_name",
			SDKLanguage:   "telemetry_sdk_language",

			Le: "le",

			Client:         "client",
			Server:         "server",
			ConnectionType: "connection_type",
		},

		SpanKinds: SpanKinds{
			Server:   "SPAN_KIND_SERVER",
			Client:   "SPAN_KIND_CLIENT",
			Producer: "SPAN_KIND_PRODUCER",
			Consumer: "SPAN_KIND_CONSUMER",
			Internal: "SPAN_KIND_INTERNAL",
		},

		StatusCodes: StatusCodes{
			Error: "STATUS_CODE_ERROR",
			OK:    "STATUS_CODE_OK",
			Unset: "STATUS_CODE_UNSET",
		},

		TraceQL: TraceQL{
			ServiceName:      "resource.service.name",
			ServiceNamespace: "resource.service.namespace",
		},

		BrowserMetrics: BrowserMetrics{
			LCP:              "browser_web_vitals_lcp_milliseconds",
			FCP:              "browser_web_vitals_fcp_milliseconds",
			CLS:              "browser_web_vitals_cls",
			INP:              "browser_web_vitals_inp_milliseconds",
			TTFB:             "browser_web_vitals_ttfb_milliseconds",
			PageLoads:        "browser_page_loads_total",
			Errors:           "browser_errors_total",
			PageLoadDuration: "browser_page_load_duration_milliseconds_bucket",
			PageRoute:        "page_route",
			BrowserName:      "browser_name",
		},

		FaroLoki: FaroLoki{
			ServiceName: "service_name",
			Kind:        "kind",
			AppName:     "app_name",

			KindMeasurement: "measurement",
			KindException:   "exception",
			KindEvent:       "event",
			KindLog:         "log",

			TypeField:     "type",
			TypeWebVitals: "web-vitals",

			FCP:  "fcp",
			LCP:  "lcp",
			CLS:  "cls",
			INP:  "inp",
			TTFB: "ttfb",

			Rating:      "context_rating",
			BrowserName: "browser_name",
			PageURL:     "page_url",
		},

		AlloyBrowserMetrics: AlloyBrowserMetrics{
			LCP:       "loki_process_custom_browser_web_vitals_lcp_milliseconds",
			FCP:       "loki_process_custom_browser_web_vitals_fcp_milliseconds",
			CLS:       "loki_process_custom_browser_web_vitals_cls",
			INP:       "loki_process_custom_browser_web_vitals_inp_milliseconds",
			TTFB:      "loki_process_custom_browser_web_vitals_ttfb_milliseconds",
			PageLoads: "loki_process_custom_browser_page_loads_total",
			Errors:    "loki_process_custom_browser_errors_total",
			AppLabel:  "app_name",
			Job:       "alloy-faro",
			Lookback:  "30m",
		},

		ServiceGraph: ServiceGraph{
			RequestTotal:        "_request_total",
			RequestFailedTotal:  "_request_failed_total",
			RequestServerBucket: "_request_server_seconds_bucket",
		},

		Runtime: RuntimeMetrics{
			Labels: RuntimeLabels{
				App:       "app",
				Namespace: "namespace",
			},
			JVM: JVMMetrics{
				MemoryUsed:      "jvm_memory_used_bytes",
				MemoryMax:       "jvm_memory_max_bytes",
				MemoryCommitted: "jvm_memory_committed_bytes",
				GCDuration:      "jvm_gc_duration_seconds",
				GCOverhead:      "jvm_gc_overhead",
				ThreadsLive:     "jvm_threads_live_threads",
				ThreadsDaemon:   "jvm_threads_daemon_threads",
				ThreadsPeak:     "jvm_threads_peak_threads",
				ThreadsStates:   "jvm_threads_states_threads",
				ClassesLoaded:   "jvm_classes_loaded_classes",
				CPUUtilization:  "jvm_cpu_recent_utilization_ratio",
				CPUCount:        "jvm_cpu_count",
				Uptime:          "process_uptime_seconds",
				BufferUsed:      "jvm_buffer_memory_used_bytes",
				BufferCapacity:  "jvm_buffer_total_capacity_bytes",
				Info:            "jvm_info",
				AreaLabel:       "area",
				GCLabel:         "gc",
				IDLabel:         "id",
				StateLabel:      "state",
			},
			NodeJS: NodeJSMetrics{
				EventLoopP99:   "nodejs_eventloop_delay_p99_seconds",
				EventLoopP90:   "nodejs_eventloop_delay_p90_seconds",
				EventLoopP50:   "nodejs_eventloop_delay_p50_seconds",
				EventLoopMean:  "nodejs_eventloop_delay_mean_seconds",
				EventLoopUtil:  "nodejs_eventloop_utilization_ratio",
				HeapUsed:       "nodejs_heap_size_used_bytes",
				HeapTotal:      "nodejs_heap_size_total_bytes",
				ExternalMem:    "nodejs_external_memory_bytes",
				RSS:            "process_resident_memory_bytes",
				GCDuration:     "nodejs_gc_duration_seconds",
				ActiveHandles:  "nodejs_active_handles",
				ActiveRequests: "nodejs_active_requests",
				CPUTotal:       "process_cpu_seconds_total",
				OpenFDs:        "process_open_fds",
				MaxFDs:         "process_max_fds",
				VersionInfo:    "nodejs_version_info",
				KindLabel:      "kind",
			},
			DBPool: DBPoolMetrics{
				HikariActive:  "hikaricp_connections_active",
				HikariIdle:    "hikaricp_connections_idle",
				HikariMax:     "hikaricp_connections_max",
				HikariPending: "hikaricp_connections_pending",
				HikariTimeout: "hikaricp_connections_timeout_total",
				HikariUsage:   "hikaricp_connections_usage_seconds",
				OtelDBActive:  "db_client_connections_usage",
				OtelDBIdle:    "db_client_connections_idle_min",
				OtelDBMax:     "db_client_connections_max",
				PoolLabel:     "pool",
			},
			Kafka: KafkaMetrics{
				ConsumerLagMax:     "kafka_consumer_records_lag_max",
				ConsumerConsumed:   "kafka_consumer_records_consumed_total",
				ProducerSent:       "kafka_producer_records_sent_total",
				TopicLabel:         "topic",
				PartitionLabel:     "partition",
				ClientIDLabel:      "client_id",
				ConsumerGroupLabel: "consumer_group",
			},
			Go: GoMetrics{
				Goroutines: "go_goroutines",
				Threads:    "go_threads",
				MemAlloc:   "go_memstats_alloc_bytes",
				MemSys:     "go_memstats_sys_bytes",
				GCDuration: "go_gc_duration_seconds",
				CPUTotal:   "process_cpu_seconds_total",
				OpenFDs:    "process_open_fds",
				MaxFDs:     "process_max_fds",
				Info:       "go_info",
			},
			Container: ContainerMetrics{
				CPUUsage:        "container_cpu_usage_seconds_total",
				CPUThrottled:    "container_cpu_cfs_throttled_seconds_total",
				MemoryUsage:     "container_memory_usage_bytes",
				ResourceReqs:    "kube_pod_container_resource_requests",
				ResourceLimits:  "kube_pod_container_resource_limits",
				Restarts:        "kube_pod_container_status_restarts_total",
				DesiredReplicas: "kube_deployment_spec_replicas",
				ContainerLabel:  "container",
				ResourceLabel:   "resource",
			},
		},
	}
}

// ---------------------------------------------------------------------------
// Query-builder helpers — keep PromQL construction DRY.
// ---------------------------------------------------------------------------

// ServiceFilter returns a PromQL label matcher for service (and optionally namespace).
//
//	`service_name="foo"` or `service_name="foo", service_namespace="bar"`
func (c *Config) ServiceFilter(service, namespace string) string {
	f := fmt.Sprintf(`%s="%s"`, c.Labels.ServiceName, service)
	if namespace != "" {
		f += fmt.Sprintf(`, %s="%s"`, c.Labels.ServiceNamespace, namespace)
	}
	return f
}

// ServerFilter returns ServiceFilter extended with span_kind=SERVER.
func (c *Config) ServerFilter(service, namespace string) string {
	return c.ServiceFilter(service, namespace) +
		fmt.Sprintf(`, %s="%s"`, c.Labels.SpanKind, c.SpanKinds.Server)
}

// ErrorFilter appends status_code=ERROR to an existing filter string.
func (c *Config) ErrorFilter(base string) string {
	return base + fmt.Sprintf(`, %s="%s"`, c.Labels.StatusCode, c.StatusCodes.Error)
}

// AlloyFilter returns a PromQL label matcher for Alloy Faro metrics.
// It matches by app_name, job, and optionally environment (k8s_cluster_name).
func (c *Config) AlloyFilter(service, environment string) string {
	f := fmt.Sprintf(`%s="%s", job="%s"`, c.AlloyBrowserMetrics.AppLabel, service, c.AlloyBrowserMetrics.Job)
	if environment != "" {
		f += fmt.Sprintf(`, %s="%s"`, c.Labels.DeploymentEnv, environment)
	}
	return f
}

// Rate wraps a metric{filter}[range] in a sum-by rate expression.
func Rate(metric, filter, groupBy, window string) string {
	if groupBy != "" {
		return fmt.Sprintf(`sum by (%s) (rate(%s{%s}%s))`, groupBy, metric, filter, window)
	}
	return fmt.Sprintf(`sum(rate(%s{%s}%s))`, metric, filter, window)
}

// RuntimeFilter returns a PromQL label matcher for app-emitted runtime metrics.
// These use app/namespace labels from Prometheus scraping, NOT service_name/service_namespace.
func (c *Config) RuntimeFilter(service, namespace string) string {
	f := fmt.Sprintf(`%s="%s"`, c.Runtime.Labels.App, service)
	if namespace != "" {
		f += fmt.Sprintf(`, %s="%s"`, c.Runtime.Labels.Namespace, namespace)
	}
	return f
}

// ContainerFilter returns a PromQL label matcher for container/kube-state-metrics.
// Uses container=service, namespace=namespace.
func (c *Config) ContainerFilter(service, namespace string) string {
	f := fmt.Sprintf(`%s="%s"`, c.Runtime.Container.ContainerLabel, service)
	if namespace != "" {
		f += fmt.Sprintf(`, %s="%s"`, c.Runtime.Labels.Namespace, namespace)
	}
	return f
}

// ---------------------------------------------------------------------------
// Loki / LogQL helpers
// ---------------------------------------------------------------------------

// LokiStreamSelector returns a Loki stream selector for a service.
//
//	{service_name="foo", kind="measurement"}
func (c *Config) LokiStreamSelector(service, kind string) string {
	sel := fmt.Sprintf(`{%s="%s"`, c.FaroLoki.ServiceName, service)
	if kind != "" {
		sel += fmt.Sprintf(`, %s="%s"`, c.FaroLoki.Kind, kind)
	}
	return sel + "}"
}

// LokiVitalQuery builds a LogQL metric query to extract a Web Vital from Faro logs.
// Uses weighted mean (sum of values / count of observations) to match the frontend Scene panels.
//
//	sum(sum_over_time({service_name="X", kind="measurement"} | logfmt | type="web-vitals" | fcp!="" | keep fcp | unwrap fcp [window]))
//	  / sum(count_over_time({service_name="X", kind="measurement"} | logfmt | type="web-vitals" | fcp!="" | keep fcp [window]))
func (c *Config) LokiVitalQuery(service, vital, window string) string {
	pipeline := fmt.Sprintf(
		`%s | logfmt | %s="%s" | %s!="" | keep %s`,
		c.LokiStreamSelector(service, c.FaroLoki.KindMeasurement),
		c.FaroLoki.TypeField, c.FaroLoki.TypeWebVitals,
		vital, vital,
	)
	return fmt.Sprintf(
		`sum(sum_over_time(%s | unwrap %s %s)) / sum(count_over_time(%s %s))`,
		pipeline, vital, window, pipeline, window,
	)
}

// LokiExceptionCount builds a LogQL metric query to count exceptions.
func (c *Config) LokiExceptionCount(service, window string) string {
	return fmt.Sprintf(
		`sum(count_over_time(%s %s))`,
		c.LokiStreamSelector(service, c.FaroLoki.KindException),
		window,
	)
}

// Quantile wraps a histogram bucket in histogram_quantile with sum-by rate.
func Quantile(q float64, bucket, filter, groupBy, leLabel, window string) string {
	gb := leLabel
	if groupBy != "" {
		gb = groupBy + ", " + leLabel
	}
	return fmt.Sprintf(`histogram_quantile(%.2f, sum by (%s) (rate(%s{%s}%s)))`, q, gb, bucket, filter, window)
}

// FormatSpanKind returns a human-readable short label for a span_kind value.
func (c *Config) FormatSpanKind(raw string) string {
	switch raw {
	case c.SpanKinds.Server:
		return "Server"
	case c.SpanKinds.Client:
		return "Client"
	case c.SpanKinds.Producer:
		return "Producer"
	case c.SpanKinds.Consumer:
		return "Consumer"
	case c.SpanKinds.Internal:
		return "Internal"
	default:
		return raw
	}
}
