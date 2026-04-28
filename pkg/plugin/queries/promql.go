package queries

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// sharedTransport is a connection-pooled HTTP transport reused across all query clients.
// This avoids repeated TCP/TLS handshakes when querying the same datasource.
var sharedTransport = &http.Transport{
	MaxIdleConns:        50,
	MaxIdleConnsPerHost: 10,
	IdleConnTimeout:     90 * time.Second,
	DialContext: (&net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext,
}

// PrometheusClient queries a Prometheus-compatible API (Mimir).
type PrometheusClient struct {
	baseURL      string
	httpClient   *http.Client
	logger       log.Logger
	serviceToken string      // Grafana service account token for internal API calls
	authHeaders  http.Header // forwarded from incoming request (fallback when no serviceToken)
}

// NewPrometheusClient creates a client that talks to a Prometheus-compatible endpoint.
func NewPrometheusClient(baseURL string, serviceToken string) *PrometheusClient {
	return &PrometheusClient{
		baseURL:      strings.TrimRight(baseURL, "/"),
		serviceToken: serviceToken,
		httpClient: &http.Client{
			Timeout:   30 * time.Second,
			Transport: sharedTransport,
		},
		logger: log.DefaultLogger.With("component", "promClient"),
	}
}

// NewLokiMetricClient creates a client for Loki's Prometheus-compatible metric query API.
// Loki exposes /loki/api/v1/query and /loki/api/v1/query_range with the same response
// format as Prometheus, so we reuse PrometheusClient with a /loki path prefix.
func NewLokiMetricClient(proxyURL string, serviceToken string) *PrometheusClient {
	return &PrometheusClient{
		baseURL:      strings.TrimRight(proxyURL, "/") + "/loki",
		serviceToken: serviceToken,
		httpClient: &http.Client{
			Timeout:   30 * time.Second,
			Transport: sharedTransport,
		},
		logger: log.DefaultLogger.With("component", "lokiMetricClient"),
	}
}

// WithAuthHeaders returns a shallow copy of the client with auth headers set.
// Use this to forward the user's authentication from the incoming request.
func (c *PrometheusClient) WithAuthHeaders(h http.Header) *PrometheusClient {
	clone := *c
	clone.authHeaders = h
	return &clone
}

// WithServiceToken returns a shallow copy of the client with the given service
// account token, overriding any token set at construction time.
func (c *PrometheusClient) WithServiceToken(token string) *PrometheusClient {
	clone := *c
	clone.serviceToken = token
	return &clone
}

// ServiceToken returns the configured Grafana service account token, if any.
func (c *PrometheusClient) ServiceToken() string {
	return c.serviceToken
}

// applyAuth sets auth headers on an outgoing HTTP request.
// When a service account token is configured, it uses that for Authorization
// while preserving X-Grafana-Org-Id from the user request.
// Without a token, it forwards Cookie, Authorization, and X-Grafana-Org-Id
// from the incoming request (works with anonymous auth / local dev).
func (c *PrometheusClient) applyAuth(req *http.Request) {
	if c.serviceToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.serviceToken)
		if vals := c.authHeaders.Values("X-Grafana-Org-Id"); len(vals) > 0 {
			for _, v := range vals {
				req.Header.Add("X-Grafana-Org-Id", v)
			}
		}
		return
	}
	for _, key := range []string{"Cookie", "Authorization", "X-Grafana-Org-Id"} {
		if vals := c.authHeaders.Values(key); len(vals) > 0 {
			for _, v := range vals {
				req.Header.Add(key, v)
			}
		}
	}
}

// PromResponse models the Prometheus HTTP API JSON envelope.
type PromResponse struct {
	Status string   `json:"status"`
	Data   PromData `json:"data"`
	Error  string   `json:"error,omitempty"`
}

// PromData holds the result set.
type PromData struct {
	ResultType string       `json:"resultType"`
	Result     []PromResult `json:"result"`
}

// PromResult is a single result from a Prometheus query.
type PromResult struct {
	Metric map[string]string `json:"metric"`
	Value  PromValue         `json:"value,omitempty"`  // instant query
	Values []PromValue       `json:"values,omitempty"` // range query
}

// PromValue is a [timestamp, "value"] pair from the Prometheus HTTP API.
// It provides type-safe access to both fields with proper error handling
// during JSON unmarshaling.
type PromValue struct {
	ts  float64
	val string
}

// NewPromValue creates a PromValue from a timestamp and string value.
// Used in tests and when constructing values programmatically.
func NewPromValue(timestamp float64, value string) PromValue {
	return PromValue{ts: timestamp, val: value}
}

// UnmarshalJSON decodes the [timestamp, "value"] pair from Prometheus API responses.
func (v *PromValue) UnmarshalJSON(data []byte) error {
	var pair [2]json.RawMessage
	if err := json.Unmarshal(data, &pair); err != nil {
		return fmt.Errorf("PromValue: expected [timestamp, value] pair: %w", err)
	}

	if err := json.Unmarshal(pair[0], &v.ts); err != nil {
		return fmt.Errorf("PromValue: invalid timestamp: %w", err)
	}

	if err := json.Unmarshal(pair[1], &v.val); err != nil {
		return fmt.Errorf("PromValue: invalid value: %w", err)
	}

	return nil
}

// MarshalJSON encodes as a [timestamp, "value"] pair for symmetry.
func (v PromValue) MarshalJSON() ([]byte, error) {
	return json.Marshal([2]interface{}{v.ts, v.val})
}

// Timestamp returns the unix timestamp.
func (v PromValue) Timestamp() int64 {
	return int64(v.ts)
}

// Float returns the float64 value, or 0 if unparseable.
func (v PromValue) Float() float64 {
	f, _ := strconv.ParseFloat(v.val, 64)
	return f
}

// InstantQuery executes a PromQL instant query.
func (c *PrometheusClient) InstantQuery(ctx context.Context, query string, t time.Time) ([]PromResult, error) {
	params := url.Values{
		"query": {query},
		"time":  {fmt.Sprintf("%d", t.Unix())},
	}
	return c.doQuery(ctx, "/api/v1/query", params)
}

// RangeQuery executes a PromQL range query.
func (c *PrometheusClient) RangeQuery(ctx context.Context, query string, start, end time.Time, step time.Duration) ([]PromResult, error) {
	params := url.Values{
		"query": {query},
		"start": {fmt.Sprintf("%d", start.Unix())},
		"end":   {fmt.Sprintf("%d", end.Unix())},
		"step":  {fmt.Sprintf("%ds", int(step.Seconds()))},
	}
	return c.doQuery(ctx, "/api/v1/query_range", params)
}

// SeriesExists checks whether a metric name has any series.
func (c *PrometheusClient) SeriesExists(ctx context.Context, metricName string) (bool, error) {
	results, err := c.InstantQuery(ctx, fmt.Sprintf("count(%s)", metricName), time.Now())
	if err != nil {
		return false, err
	}
	for _, r := range results {
		if r.Value.Float() > 0 {
			return true, nil
		}
	}
	return false, nil
}

// LabelValues fetches all values for a given label name via /api/v1/label/<name>/values.
func (c *PrometheusClient) LabelValues(ctx context.Context, labelName string) ([]string, error) {
	reqURL := c.baseURL + "/api/v1/label/" + url.PathEscape(labelName) + "/values"

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}
	c.applyAuth(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetching label values: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, fmt.Errorf("reading response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("label values returned %d: %s", resp.StatusCode, string(body))
	}

	var envelope struct {
		Status string   `json:"status"`
		Data   []string `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("unmarshaling label values: %w", err)
	}
	return envelope.Data, nil
}

func (c *PrometheusClient) doQuery(ctx context.Context, path string, params url.Values) ([]PromResult, error) {
	reqURL := c.baseURL + path + "?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}
	c.applyAuth(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing query: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20)) // 10 MB max
	if err != nil {
		return nil, fmt.Errorf("reading response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("prometheus returned %d: %s", resp.StatusCode, string(body))
	}

	var pr PromResponse
	if err := json.Unmarshal(body, &pr); err != nil {
		return nil, fmt.Errorf("unmarshaling response: %w", err)
	}

	if pr.Status != "success" {
		return nil, fmt.Errorf("prometheus query error: %s", pr.Error)
	}

	return pr.Data.Result, nil
}
