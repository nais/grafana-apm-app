package queries

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// RulesResponse models the Prometheus /api/v1/rules response.
type RulesResponse struct {
	Groups []RuleGroup `json:"groups"`
}

// RuleGroup is a named group of rules.
type RuleGroup struct {
	Name     string `json:"name"`
	File     string `json:"file"`
	Interval int    `json:"interval"`
	Rules    []Rule `json:"rules"`
}

// Rule represents an alerting or recording rule.
type Rule struct {
	Type           string            `json:"type"`
	Name           string            `json:"name"`
	Query          string            `json:"query"`
	Duration       float64           `json:"duration"`
	State          string            `json:"state"`
	Labels         map[string]string `json:"labels"`
	Annotations    map[string]string `json:"annotations"`
	Alerts         []Alert           `json:"alerts"`
	Health         string            `json:"health"`
	LastEvaluation string            `json:"lastEvaluation"`
	EvaluationTime float64           `json:"evaluationTime"`
}

// Alert is a single firing/pending alert instance.
type Alert struct {
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations"`
	State       string            `json:"state"`
	ActiveAt    string            `json:"activeAt"`
	Value       string            `json:"value"`
}

// GetAlertRules fetches all alerting rules from the Prometheus /api/v1/rules endpoint.
func (c *PrometheusClient) GetAlertRules(ctx context.Context) (*RulesResponse, error) {
	reqURL := c.baseURL + "/api/v1/rules?type=alerting"

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("creating rules request: %w", err)
	}
	c.applyAuth(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetching rules: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return nil, fmt.Errorf("reading rules response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("rules API returned %d: %s", resp.StatusCode, string(body))
	}

	var envelope struct {
		Status string        `json:"status"`
		Data   RulesResponse `json:"data"`
		Error  string        `json:"error,omitempty"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("unmarshaling rules: %w", err)
	}
	if envelope.Status != "success" {
		return nil, fmt.Errorf("rules API error: %s", envelope.Error)
	}

	return &envelope.Data, nil
}
