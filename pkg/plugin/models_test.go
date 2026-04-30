package plugin

import (
	"encoding/json"
	"testing"
)

// Contract tests verify that JSON serialization matches what the TypeScript
// frontend expects. These guard against silent drift between Go struct tags
// and TypeScript interfaces in src/api/client.ts.

func TestServiceMapNodeJSON(t *testing.T) {
	node := ServiceMapNode{
		ID:        "my-service",
		Title:     "my-service",
		MainStat:  "120 req/s",
		ArcErrors: 0.05,
		ArcOK:     0.95,
		NodeType:  "service",
		ErrorRate: 5.0,
	}
	data, err := json.Marshal(node)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// Verify Grafana-required underscore fields serialize correctly
	if _, ok := m["arc__errors"]; !ok {
		t.Error("expected arc__errors key in JSON")
	}
	if _, ok := m["arc__ok"]; !ok {
		t.Error("expected arc__ok key in JSON")
	}
	// Verify omitempty: subtitle should be absent when empty
	if _, ok := m["subtitle"]; ok {
		t.Error("expected subtitle to be omitted when empty")
	}
	// isSidecar should be omitted when false
	if _, ok := m["isSidecar"]; ok {
		t.Error("expected isSidecar to be omitted when false")
	}
	// isHub should be omitted when false
	if _, ok := m["isHub"]; ok {
		t.Error("expected isHub to be omitted when false")
	}
	// hubDegree should be omitted when zero
	if _, ok := m["hubDegree"]; ok {
		t.Error("expected hubDegree to be omitted when zero")
	}

	// isSidecar should be present when true
	node.IsSidecar = true
	data, _ = json.Marshal(node)
	_ = json.Unmarshal(data, &m)
	if v, ok := m["isSidecar"]; !ok || v != true {
		t.Errorf("expected isSidecar=true, got %v", m["isSidecar"])
	}

	// isHub and hubDegree should be present when set
	node.IsHub = true
	node.HubDegree = 316
	data, _ = json.Marshal(node)
	_ = json.Unmarshal(data, &m)
	if v, ok := m["isHub"]; !ok || v != true {
		t.Errorf("expected isHub=true, got %v", m["isHub"])
	}
	if v, ok := m["hubDegree"]; !ok || v != float64(316) {
		t.Errorf("expected hubDegree=316, got %v", m["hubDegree"])
	}
}

func TestGraphQLOperationNullableErrorRate(t *testing.T) {
	// nil errorRate should serialize as JSON null
	op := GraphQLOperation{
		Name:        "getUser",
		Rate:        10.5,
		ErrorRate:   nil,
		AvgLatency:  0.05,
		LatencyUnit: "s",
	}
	data, err := json.Marshal(op)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m["errorRate"] != nil {
		t.Errorf("expected errorRate to be null, got %v", m["errorRate"])
	}

	// non-nil errorRate should serialize as a number
	rate := 12.5
	op.ErrorRate = &rate
	data, err = json.Marshal(op)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m["errorRate"] != 12.5 {
		t.Errorf("expected errorRate 12.5, got %v", m["errorRate"])
	}
}

func TestFrontendMetricsResponseOmitempty(t *testing.T) {
	// Empty response: source and vitals should be omitted
	resp := FrontendMetricsResponse{Available: false}
	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := m["source"]; ok {
		t.Error("expected source to be omitted when empty")
	}
	if _, ok := m["vitals"]; ok {
		t.Error("expected vitals to be omitted when nil")
	}
	// available and errorRate should always be present
	if _, ok := m["available"]; !ok {
		t.Error("expected available field to be present")
	}
	if _, ok := m["errorRate"]; !ok {
		t.Error("expected errorRate field to be present")
	}
}

func TestConnectedServicesResponseJSON(t *testing.T) {
	resp := ConnectedServicesResponse{
		Inbound: []ConnectedService{
			{Name: "caller", Rate: 50, ErrorRate: 1.2, P95Duration: 0.015, DurationUnit: "s"},
		},
		Outbound: []ConnectedService{
			{Name: "db", ConnectionType: "database", Rate: 100, P95Duration: 15, DurationUnit: "ms"},
			{Name: "wonderwall", IsSidecar: true, Rate: 200, P95Duration: 5, DurationUnit: "ms"},
		},
	}
	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// Round-trip: unmarshal back and verify
	var got ConnectedServicesResponse
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Inbound) != 1 || got.Inbound[0].Name != "caller" {
		t.Errorf("inbound mismatch: %+v", got.Inbound)
	}
	if len(got.Outbound) != 2 || got.Outbound[0].ConnectionType != "database" {
		t.Errorf("outbound mismatch: %+v", got.Outbound)
	}
	// Verify sidecar field round-trips
	if !got.Outbound[1].IsSidecar {
		t.Error("expected wonderwall to have isSidecar=true")
	}
	if got.Inbound[0].IsSidecar {
		t.Error("expected caller to have isSidecar=false (omitted)")
	}

	// connectionType should be omitted when empty
	svc := ConnectedService{Name: "svc", Rate: 1}
	svcData, _ := json.Marshal(svc)
	var m map[string]interface{}
	_ = json.Unmarshal(svcData, &m)
	if _, ok := m["connectionType"]; ok {
		t.Error("expected connectionType to be omitted when empty")
	}
	// isSidecar should be omitted when false
	if _, ok := m["isSidecar"]; ok {
		t.Error("expected isSidecar to be omitted when false")
	}
}

func TestDependencySummaryJSON(t *testing.T) {
	dep := DependencySummary{
		Name:         "postgres",
		Type:         "database",
		Rate:         250,
		ErrorRate:    0.5,
		P95Duration:  3.2,
		DurationUnit: "ms",
		Impact:       75.0,
	}
	data, err := json.Marshal(dep)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got DependencySummary
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Name != "postgres" || got.Type != "database" || got.Impact != 75.0 {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}
