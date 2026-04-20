package queries

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// PrometheusClient queries a Prometheus-compatible API (Mimir).
type PrometheusClient struct {
	baseURL    string
	httpClient *http.Client
	logger     log.Logger
	authHeaders http.Header // forwarded from incoming request
}

// NewPrometheusClient creates a client that talks to a Prometheus-compatible endpoint.
func NewPrometheusClient(baseURL string) *PrometheusClient {
	return &PrometheusClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		logger: log.DefaultLogger.With("component", "promClient"),
	}
}

// NewLokiMetricClient creates a client for Loki's Prometheus-compatible metric query API.
// Loki exposes /loki/api/v1/query and /loki/api/v1/query_range with the same response
// format as Prometheus, so we reuse PrometheusClient with a /loki path prefix.
func NewLokiMetricClient(proxyURL string) *PrometheusClient {
	return &PrometheusClient{
		baseURL: strings.TrimRight(proxyURL, "/") + "/loki",
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
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

// PromValue is a [timestamp, "value"] pair.
type PromValue [2]interface{}

// Timestamp returns the unix timestamp from the value pair.
func (v PromValue) Timestamp() int64 {
	switch t := v[0].(type) {
	case float64:
		return int64(t)
	case json.Number:
		i, _ := t.Int64()
		return i
	}
	return 0
}

// Float returns the float64 value from the value pair.
func (v PromValue) Float() float64 {
	switch s := v[1].(type) {
	case string:
		f, _ := strconv.ParseFloat(s, 64)
		return f
	}
	return 0
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
	for _, key := range []string{"Cookie", "Authorization", "X-Grafana-Org-Id"} {
		if vals := c.authHeaders.Values(key); len(vals) > 0 {
			for _, v := range vals {
				req.Header.Add(key, v)
			}
		}
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetching label values: %w", err)
	}
	defer resp.Body.Close()

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

	// Forward auth headers from the incoming user request
	for _, key := range []string{"Cookie", "Authorization", "X-Grafana-Org-Id"} {
		if vals := c.authHeaders.Values(key); len(vals) > 0 {
			for _, v := range vals {
				req.Header.Add(key, v)
			}
		}
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing query: %w", err)
	}
	defer resp.Body.Close()

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
