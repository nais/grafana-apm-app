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
	// MaxLines/Direction apply to Loki log (range) queries only.
	MaxLines  int    `json:"maxLines,omitempty"`
	Direction string `json:"direction,omitempty"`
}

type dsQueryDsRef struct {
	UID string `json:"uid"`
}

// dsQueryFrame is one data frame in a /api/ds/query response.
type dsQueryFrame struct {
	Schema struct {
		Fields []struct {
			Name   string            `json:"name"`
			Labels map[string]string `json:"labels,omitempty"`
		} `json:"fields"`
	} `json:"schema"`
	Data struct {
		Values []json.RawMessage `json:"values"`
	} `json:"data"`
}

// dsQueryResponse mirrors the frame envelope of /api/ds/query.
type dsQueryResponse struct {
	Results map[string]struct {
		Error  string         `json:"error,omitempty"`
		Frames []dsQueryFrame `json:"frames"`
	} `json:"results"`
}

// execute posts a single-target ds query and returns the frames for refId A.
func (c *DsQueryClient) execute(ctx context.Context, dsReq dsQueryRequest) ([]dsQueryFrame, error) {
	body, err := json.Marshal(dsReq)
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
	return result.Frames, nil
}

// InstantQuery runs an instant metric query (LogQL or PromQL) via the
// datasource query API and flattens the resulting frames into PromResults.
func (c *DsQueryClient) InstantQuery(ctx context.Context, dsUID, expr string, at time.Time) ([]PromResult, error) {
	// A zero-width window confuses some datasource implementations; give the
	// request a nominal from while anchoring evaluation at `to`.
	frames, err := c.execute(ctx, dsQueryRequest{
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
		return nil, err
	}

	// Instant vector: one frame per series (or one frame with multiple value
	// fields); labels ride on the value field, values as [times[], values[]].
	var out []PromResult
	for _, frame := range frames {
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

// LogEntry is one raw log line returned by a Loki log query.
type LogEntry struct {
	// TimeMs is the entry timestamp in epoch milliseconds.
	TimeMs int64
	// Line is the raw log line (logfmt for Faro streams).
	Line string
}

// LogQuery runs a Loki log (range) query via the datasource query API and
// flattens the log frames into timestamped raw lines. Direction is backward:
// with limit lines available, the newest ones win.
func (c *DsQueryClient) LogQuery(ctx context.Context, dsUID, expr string, from, to time.Time, limit int) ([]LogEntry, error) {
	frames, err := c.execute(ctx, dsQueryRequest{
		From: strconv.FormatInt(from.UnixMilli(), 10),
		To:   strconv.FormatInt(to.UnixMilli(), 10),
		Queries: []dsQueryTarget{{
			RefID:      "A",
			Datasource: dsQueryDsRef{UID: dsUID},
			Expr:       expr,
			QueryType:  "range",
			Range:      true,
			MaxLines:   limit,
			Direction:  "backward",
		}},
	})
	if err != nil {
		return nil, err
	}

	// Log frames carry parallel value arrays; the time and line columns are
	// named "Time"/"Line" (legacy) or "timestamp"/"body" (dataplane).
	var out []LogEntry
	for _, frame := range frames {
		timeIdx, lineIdx := -1, -1
		for i, f := range frame.Schema.Fields {
			switch f.Name {
			case "Time", "time", "timestamp", "ts":
				if timeIdx < 0 {
					timeIdx = i
				}
			case "Line", "line", "body":
				if lineIdx < 0 {
					lineIdx = i
				}
			}
		}
		if timeIdx < 0 || lineIdx < 0 || timeIdx >= len(frame.Data.Values) || lineIdx >= len(frame.Data.Values) {
			continue
		}
		var times []float64
		var lines []string
		if err := json.Unmarshal(frame.Data.Values[timeIdx], &times); err != nil {
			continue
		}
		if err := json.Unmarshal(frame.Data.Values[lineIdx], &lines); err != nil {
			continue
		}
		for i := 0; i < len(times) && i < len(lines); i++ {
			out = append(out, LogEntry{TimeMs: int64(times[i]), Line: lines[i]})
		}
	}
	return out, nil
}

// LogEntryWithLabels is one raw log line plus its per-entry label set: the
// stream labels merged with structured metadata (and any parser-stage fields),
// exactly as the Loki datasource surfaces them in the log frame's `labels`
// field. This is the recovery path for OTLP/semconv exception attributes
// (exception_type / exception_message / exception_stacktrace / k8s_pod_name /
// detected_level), which arrive as structured metadata rather than in the line
// body.
type LogEntryWithLabels struct {
	// TimeMs is the entry timestamp in epoch milliseconds.
	TimeMs int64
	// Line is the raw log line body.
	Line string
	// Labels is the per-entry label map (stream labels + structured metadata +
	// parser fields). Nil when the frame carried no labels column.
	Labels map[string]string
}

// LogQueryWithLabels is LogQuery's structured-metadata-aware variant: alongside
// the timestamp and line body it returns each entry's label map, parsed from
// the log frame's `labels` column (dataplane format) or, failing that, from the
// line field's frame-level schema labels (legacy streams). Server-issue
// occurrence extraction needs the structured metadata (exception attributes,
// pod name, detected level) that plain LogQuery drops.
func (c *DsQueryClient) LogQueryWithLabels(ctx context.Context, dsUID, expr string, from, to time.Time, limit int) ([]LogEntryWithLabels, error) {
	frames, err := c.execute(ctx, dsQueryRequest{
		From: strconv.FormatInt(from.UnixMilli(), 10),
		To:   strconv.FormatInt(to.UnixMilli(), 10),
		Queries: []dsQueryTarget{{
			RefID:      "A",
			Datasource: dsQueryDsRef{UID: dsUID},
			Expr:       expr,
			QueryType:  "range",
			Range:      true,
			MaxLines:   limit,
			Direction:  "backward",
		}},
	})
	if err != nil {
		return nil, err
	}

	var out []LogEntryWithLabels
	for _, frame := range frames {
		timeIdx, lineIdx, labelsIdx := -1, -1, -1
		for i, f := range frame.Schema.Fields {
			switch f.Name {
			case "Time", "time", "timestamp", "ts":
				if timeIdx < 0 {
					timeIdx = i
				}
			case "Line", "line", "body":
				if lineIdx < 0 {
					lineIdx = i
				}
			case "labels", "Labels":
				if labelsIdx < 0 {
					labelsIdx = i
				}
			}
		}
		if timeIdx < 0 || lineIdx < 0 || timeIdx >= len(frame.Data.Values) || lineIdx >= len(frame.Data.Values) {
			continue
		}
		var times []float64
		var lines []string
		if err := json.Unmarshal(frame.Data.Values[timeIdx], &times); err != nil {
			continue
		}
		if err := json.Unmarshal(frame.Data.Values[lineIdx], &lines); err != nil {
			continue
		}
		// Per-row label maps live in the dedicated `labels` column. When it is
		// absent (legacy per-stream frames), the labels ride on the line field's
		// schema and apply to every row in the frame.
		var rowLabels []map[string]string
		if labelsIdx >= 0 && labelsIdx < len(frame.Data.Values) {
			rowLabels = parseLabelsColumn(frame.Data.Values[labelsIdx])
		}
		frameLabels := frame.Schema.Fields[lineIdx].Labels
		for i := 0; i < len(times) && i < len(lines); i++ {
			lbls := frameLabels
			if i < len(rowLabels) && rowLabels[i] != nil {
				lbls = rowLabels[i]
			}
			out = append(out, LogEntryWithLabels{TimeMs: int64(times[i]), Line: lines[i], Labels: lbls})
		}
	}
	return out, nil
}

// parseLabelsColumn decodes the log frame's `labels` column into per-row label
// maps. The datasource emits it either as an array of JSON objects (the common
// dataplane form) or, in some versions, as an array of JSON-encoded strings;
// both are handled, and anything unparseable degrades to nil (message-only).
func parseLabelsColumn(raw json.RawMessage) []map[string]string {
	if len(raw) == 0 {
		return nil
	}
	var objs []map[string]string
	if err := json.Unmarshal(raw, &objs); err == nil {
		return objs
	}
	var strs []string
	if err := json.Unmarshal(raw, &strs); err == nil {
		out := make([]map[string]string, len(strs))
		for i, s := range strs {
			m := map[string]string{}
			_ = json.Unmarshal([]byte(s), &m)
			out[i] = m
		}
		return out
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
