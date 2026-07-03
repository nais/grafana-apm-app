package queries

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// DsQueryClient executes queries through Grafana's datasource query API
// (POST /api/ds/query) instead of the legacy per-datasource proxy routes.
// The query API is the sanctioned path: it works for every datasource type,
// applies Grafana's own datasource auth, and — unlike the proxy — is not
// deprecated. Responses arrive as data frames, which we flatten back into
// the PromResult shape the rest of the backend consumes.
type DsQueryClient struct {
	grafanaURL   string
	serviceToken string
	httpClient   *http.Client
	headers      http.Header
}

// NewDsQueryClient creates a client for Grafana's /api/ds/query endpoint.
func NewDsQueryClient(grafanaURL, serviceToken string) *DsQueryClient {
	return &DsQueryClient{
		grafanaURL:   grafanaURL,
		serviceToken: serviceToken,
		httpClient: &http.Client{
			Timeout:   30 * time.Second,
			Transport: sharedTransport,
		},
	}
}

// WithAuthHeaders returns a shallow copy that forwards the given request
// headers (cookie/authorization) when no service token is configured.
func (c *DsQueryClient) WithAuthHeaders(h http.Header) *DsQueryClient {
	cp := *c
	cp.headers = h
	return &cp
}

type dsQueryRequest struct {
	From    string          `json:"from"`
	To      string          `json:"to"`
	Queries []dsQueryTarget `json:"queries"`
}

type dsQueryTarget struct {
	RefID      string       `json:"refId"`
	Datasource dsQueryDsRef `json:"datasource"`
	Expr       string       `json:"expr"`
	// QueryType/Instant select Loki's (and Prometheus') instant metric mode.
	QueryType string `json:"queryType,omitempty"`
	Instant   bool   `json:"instant"`
	Range     bool   `json:"range"`
}

type dsQueryDsRef struct {
	UID string `json:"uid"`
}

// dsQueryResponse mirrors the frame envelope of /api/ds/query.
type dsQueryResponse struct {
	Results map[string]struct {
		Error  string `json:"error,omitempty"`
		Frames []struct {
			Schema struct {
				Fields []struct {
					Name   string            `json:"name"`
					Labels map[string]string `json:"labels,omitempty"`
				} `json:"fields"`
			} `json:"schema"`
			Data struct {
				Values []json.RawMessage `json:"values"`
			} `json:"data"`
		} `json:"frames"`
	} `json:"results"`
}

// InstantQuery runs an instant metric query (LogQL or PromQL) via the
// datasource query API and flattens the resulting frames into PromResults.
func (c *DsQueryClient) InstantQuery(ctx context.Context, dsUID, expr string, at time.Time) ([]PromResult, error) {
	// A zero-width window confuses some datasource implementations; give the
	// request a nominal from while anchoring evaluation at `to`.
	body, err := json.Marshal(dsQueryRequest{
		From: strconv.FormatInt(at.Add(-time.Minute).UnixMilli(), 10),
		To:   strconv.FormatInt(at.UnixMilli(), 10),
		Queries: []dsQueryTarget{{
			RefID:      "A",
			Datasource: dsQueryDsRef{UID: dsUID},
			Expr:       expr,
			QueryType:  "instant",
			Instant:    true,
		}},
	})
	if err != nil {
		return nil, fmt.Errorf("marshaling ds query: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.grafanaURL+"/api/ds/query", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("creating ds query request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.serviceToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.serviceToken)
	} else if c.headers != nil {
		for _, h := range []string{"Cookie", "Authorization", "X-Grafana-Org-Id", "X-Grafana-Id"} {
			if v := c.headers.Get(h); v != "" {
				req.Header.Set(h, v)
			}
		}
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("executing ds query: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
	if err != nil {
		return nil, fmt.Errorf("reading ds query response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ds query returned %d: %s", resp.StatusCode, truncate(string(raw), 512))
	}

	var envelope dsQueryResponse
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("unmarshaling ds query response: %w", err)
	}
	result, ok := envelope.Results["A"]
	if !ok {
		return nil, fmt.Errorf("ds query response missing refId A")
	}
	if result.Error != "" {
		return nil, fmt.Errorf("ds query error: %s", result.Error)
	}

	// Instant vector: one frame per series (or one frame with multiple value
	// fields); labels ride on the value field, values as [times[], values[]].
	var out []PromResult
	for _, frame := range result.Frames {
		if len(frame.Schema.Fields) < 2 || len(frame.Data.Values) < 2 {
			continue
		}
		for i := 1; i < len(frame.Schema.Fields) && i < len(frame.Data.Values); i++ {
			var vals []float64
			if err := json.Unmarshal(frame.Data.Values[i], &vals); err != nil || len(vals) == 0 {
				continue
			}
			out = append(out, PromResult{
				Metric: frame.Schema.Fields[i].Labels,
				Value:  NewPromValue(float64(at.UnixMilli())/1000, strconv.FormatFloat(vals[len(vals)-1], 'f', -1, 64)),
			})
		}
	}
	return out, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
