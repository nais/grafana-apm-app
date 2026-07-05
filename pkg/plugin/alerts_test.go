package plugin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

func TestExtractNamespaceFromGroupFile(t *testing.T) {
	tests := []struct {
		file     string
		expected string
	}{
		// NAIS format: {cluster}/{namespace}/{rulename}/{uuid}
		{"dev-fss/teamfrikort/frikort-alerts/869209f5-6602-4ebc-85c2-4ae3df3fd3ee", "teamfrikort"},
		{"dev/amt/amt-prometheus-alerts/24842d8c-7800-493c-ad4e-a4ba94c71c27", "amt"},
		{"prod-gcp/nais-system/sla-rules/abc123", "nais-system"},
		// Legacy simple format: {namespace}/{filename}
		{"myteam/alerts.yaml", "alerts.yaml"},
		// Edge cases
		{"alerts.yaml", ""},
		{"", ""},
		{"single/", ""},
	}
	for _, tc := range tests {
		got := extractNamespaceFromGroupFile(tc.file)
		if got != tc.expected {
			t.Errorf("extractNamespaceFromGroupFile(%q) = %q, want %q", tc.file, got, tc.expected)
		}
	}
}

// mockRulerServer returns a test server that serves the Mimir /api/v1/rules endpoint.
func mockRulerServer(t *testing.T, groups []queries.RuleGroup) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/rules" {
			resp := struct {
				Status string `json:"status"`
				Data   struct {
					Groups []queries.RuleGroup `json:"groups"`
				} `json:"data"`
			}{
				Status: "success",
			}
			resp.Data.Groups = groups
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(resp)
			return
		}
		// For any other path, return empty PromQL response (for capability detection etc.)
		resp := queries.PromResponse{
			Status: "success",
			Data:   queries.PromData{ResultType: "vector", Result: []queries.PromResult{}},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
}

func TestHandleNamespaceAlerts(t *testing.T) {
	groups := []queries.RuleGroup{
		{
			Name: "myteam-alerts",
			File: "dev/myteam/myteam-alerts/abc123",
			Rules: []queries.Rule{
				{
					Type:  "alerting",
					Name:  "HighErrorRate",
					State: "firing",
					Labels: map[string]string{
						"namespace": "myteam",
						"severity":  "critical",
					},
					Annotations: map[string]string{
						"summary": "Error rate too high",
					},
					Alerts: []queries.Alert{
						{State: "firing", ActiveAt: "2026-04-25T10:00:00Z"},
						{State: "firing", ActiveAt: "2026-04-25T10:05:00Z"},
					},
				},
				{
					Type:  "alerting",
					Name:  "DiskUsage",
					State: "inactive",
					Labels: map[string]string{
						"namespace": "myteam",
						"severity":  "warning",
					},
					Annotations: map[string]string{
						"summary": "Disk above 80%",
					},
					Alerts: []queries.Alert{},
				},
				{
					Type:  "recording",
					Name:  "some:recording:rule",
					State: "",
					Labels: map[string]string{
						"namespace": "myteam",
					},
				},
			},
		},
		{
			Name: "otherteam-alerts",
			File: "dev/otherteam/otherteam-alerts/def456",
			Rules: []queries.Rule{
				{
					Type:  "alerting",
					Name:  "OtherAlert",
					State: "firing",
					Labels: map[string]string{
						"namespace": "otherteam",
						"severity":  "critical",
					},
					Alerts: []queries.Alert{
						{State: "firing", ActiveAt: "2026-04-25T11:00:00Z"},
					},
				},
			},
		},
		{
			// Group with no namespace label — relies on file path extraction
			Name: "infra-rules",
			File: "dev-fss/myteam/infra-alerts/ghi789",
			Rules: []queries.Rule{
				{
					Type:  "alerting",
					Name:  "PodCrashLoop",
					State: "pending",
					Labels: map[string]string{
						"severity": "warning",
					},
					Annotations: map[string]string{
						"summary": "Pod restarting",
					},
					Alerts: []queries.Alert{
						{State: "pending", ActiveAt: "2026-04-25T12:00:00Z"},
					},
				},
			},
		},
	}

	srv := mockRulerServer(t, groups)
	defer srv.Close()

	app := newTestApp(t, srv.URL, queries.Capabilities{})

	t.Run("filters by namespace label", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/namespaces/myteam/alerts", nil)
		req.SetPathValue("namespace", "myteam")
		w := httptest.NewRecorder()

		app.handleNamespaceAlerts(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp NamespaceAlertsResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}

		// Should get 3 alerting rules: HighErrorRate (firing), PodCrashLoop (pending, via file path), DiskUsage (inactive)
		// The recording rule should be excluded
		if len(resp.Rules) != 3 {
			t.Fatalf("expected 3 rules, got %d: %+v", len(resp.Rules), resp.Rules)
		}

		// Verify sort order: firing → pending → inactive
		if resp.Rules[0].Name != "HighErrorRate" || resp.Rules[0].State != "firing" {
			t.Errorf("first rule should be HighErrorRate (firing), got %s (%s)", resp.Rules[0].Name, resp.Rules[0].State)
		}
		if resp.Rules[1].Name != "PodCrashLoop" || resp.Rules[1].State != "pending" {
			t.Errorf("second rule should be PodCrashLoop (pending), got %s (%s)", resp.Rules[1].Name, resp.Rules[1].State)
		}
		if resp.Rules[2].Name != "DiskUsage" || resp.Rules[2].State != "inactive" {
			t.Errorf("third rule should be DiskUsage (inactive), got %s (%s)", resp.Rules[2].Name, resp.Rules[2].State)
		}

		// Verify activeCount and activeSince
		if resp.Rules[0].ActiveCount != 2 {
			t.Errorf("HighErrorRate should have 2 active instances, got %d", resp.Rules[0].ActiveCount)
		}
		if resp.Rules[0].ActiveSince != "2026-04-25T10:00:00Z" {
			t.Errorf("HighErrorRate activeSince should be earliest, got %s", resp.Rules[0].ActiveSince)
		}
		if resp.Rules[0].Severity != "critical" {
			t.Errorf("expected severity critical, got %s", resp.Rules[0].Severity)
		}
		if resp.Rules[0].Summary != "Error rate too high" {
			t.Errorf("expected summary from annotations, got %s", resp.Rules[0].Summary)
		}
	})

	t.Run("excludes other namespaces", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/namespaces/otherteam/alerts", nil)
		req.SetPathValue("namespace", "otherteam")
		w := httptest.NewRecorder()

		app.handleNamespaceAlerts(w, req)

		var resp NamespaceAlertsResponse
		_ = json.Unmarshal(w.Body.Bytes(), &resp)

		if len(resp.Rules) != 1 {
			t.Fatalf("expected 1 rule for otherteam, got %d", len(resp.Rules))
		}
		if resp.Rules[0].Name != "OtherAlert" {
			t.Errorf("expected OtherAlert, got %s", resp.Rules[0].Name)
		}
	})

	t.Run("no substring collision", func(t *testing.T) {
		// "my" should not match "myteam"
		req := httptest.NewRequest("GET", "/namespaces/my/alerts", nil)
		req.SetPathValue("namespace", "my")
		w := httptest.NewRecorder()

		app.handleNamespaceAlerts(w, req)

		var resp NamespaceAlertsResponse
		_ = json.Unmarshal(w.Body.Bytes(), &resp)

		if len(resp.Rules) != 0 {
			t.Fatalf("expected 0 rules for 'my' (no substring match), got %d", len(resp.Rules))
		}
	})

	t.Run("empty namespace returns empty", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/namespaces/nonexistent/alerts", nil)
		req.SetPathValue("namespace", "nonexistent")
		w := httptest.NewRecorder()

		app.handleNamespaceAlerts(w, req)

		var resp NamespaceAlertsResponse
		_ = json.Unmarshal(w.Body.Bytes(), &resp)

		if len(resp.Rules) != 0 {
			t.Fatalf("expected 0 rules, got %d", len(resp.Rules))
		}
		if resp.Unavailable {
			t.Error("should not be unavailable")
		}
	})
}

func TestHandleNamespaceAlerts_Deduplication(t *testing.T) {
	// Same rule name in two different clusters — should be merged
	groups := []queries.RuleGroup{
		{
			Name: "myteam-alerts",
			File: "dev/myteam/myteam-alerts/abc123",
			Rules: []queries.Rule{
				{
					Type:  "alerting",
					Name:  "HighErrorRate",
					State: "firing",
					Labels: map[string]string{
						"namespace": "myteam",
						"severity":  "critical",
					},
					Annotations: map[string]string{
						"summary": "Error rate too high",
					},
					Alerts: []queries.Alert{
						{State: "firing", ActiveAt: "2026-04-25T10:00:00Z"},
					},
				},
			},
		},
		{
			Name: "myteam-alerts",
			File: "dev-fss/myteam/myteam-alerts/def456",
			Rules: []queries.Rule{
				{
					Type:  "alerting",
					Name:  "HighErrorRate",
					State: "firing",
					Labels: map[string]string{
						"namespace": "myteam",
						"severity":  "critical",
					},
					Annotations: map[string]string{
						"summary": "Error rate too high",
					},
					Alerts: []queries.Alert{
						{State: "firing", ActiveAt: "2026-04-25T09:00:00Z"},
					},
				},
				{
					Type:  "alerting",
					Name:  "DiskUsage",
					State: "inactive",
					Labels: map[string]string{
						"namespace": "myteam",
						"severity":  "warning",
					},
					Alerts: []queries.Alert{},
				},
			},
		},
	}

	srv := mockRulerServer(t, groups)
	defer srv.Close()
	app := newTestApp(t, srv.URL, queries.Capabilities{})

	req := httptest.NewRequest("GET", "/namespaces/myteam/alerts", nil)
	req.SetPathValue("namespace", "myteam")
	w := httptest.NewRecorder()

	app.handleNamespaceAlerts(w, req)

	var resp NamespaceAlertsResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)

	// HighErrorRate should be deduped into 1, plus DiskUsage = 2 total
	if len(resp.Rules) != 2 {
		t.Fatalf("expected 2 rules after dedup, got %d: %+v", len(resp.Rules), resp.Rules)
	}

	// Find the merged HighErrorRate
	var her *AlertRuleSummary
	for i := range resp.Rules {
		if resp.Rules[i].Name == "HighErrorRate" {
			her = &resp.Rules[i]
			break
		}
	}
	if her == nil {
		t.Fatal("HighErrorRate not found in response")
	}
	if her.ActiveCount != 2 {
		t.Errorf("expected merged activeCount=2, got %d", her.ActiveCount)
	}
	if her.ActiveSince != "2026-04-25T09:00:00Z" {
		t.Errorf("expected earliest activeSince, got %s", her.ActiveSince)
	}
}

func TestHandleNamespaceAlerts_RulerUnavailable(t *testing.T) {
	// Server that returns 404 for rules API
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/rules" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		resp := queries.PromResponse{
			Status: "success",
			Data:   queries.PromData{ResultType: "vector", Result: []queries.PromResult{}},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	app := newTestApp(t, srv.URL, queries.Capabilities{})

	req := httptest.NewRequest("GET", "/namespaces/myteam/alerts", nil)
	req.SetPathValue("namespace", "myteam")
	w := httptest.NewRecorder()

	app.handleNamespaceAlerts(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 (graceful degradation), got %d", w.Code)
	}

	var resp NamespaceAlertsResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)

	if !resp.Unavailable {
		t.Error("expected unavailable=true when ruler returns 404")
	}
	if len(resp.Rules) != 0 {
		t.Errorf("expected empty rules, got %d", len(resp.Rules))
	}
}

func TestHandleServiceAlerts(t *testing.T) {
	// A rule mentions the service via a quoted occurrence in its PromQL query
	// (service_name="orders") or an exact service/app label — the conservative
	// ruleMentionsService matcher. Rules for other services must not leak in.
	groups := []queries.RuleGroup{
		{
			Name: "orders-alerts",
			File: "dev/teamorders/orders-alerts/abc123",
			Rules: []queries.Rule{
				{
					Type:  "alerting",
					Name:  "OrdersHighErrorRate",
					Query: `sum(rate(calls_total{service_name="orders"}[5m])) > 0.05`,
					State: "firing",
					Labels: map[string]string{
						"namespace": "teamorders",
						"severity":  "critical",
					},
					Annotations: map[string]string{"summary": "Orders erroring"},
					Alerts: []queries.Alert{
						{State: "firing", ActiveAt: "2026-04-25T10:00:00Z"},
					},
				},
				{
					Type:  "alerting",
					Name:  "OrdersLabelMatch",
					Query: `up == 0`,
					State: "inactive",
					Labels: map[string]string{
						"namespace": "teamorders",
						"service":   "orders",
					},
					Alerts: []queries.Alert{},
				},
				{
					// Different service — must be excluded.
					Type:   "alerting",
					Name:   "PaymentsDown",
					Query:  `sum(rate(calls_total{service_name="payments"}[5m])) > 0.05`,
					State:  "firing",
					Labels: map[string]string{"namespace": "teamorders"},
					Alerts: []queries.Alert{{State: "firing", ActiveAt: "2026-04-25T11:00:00Z"}},
				},
				{
					// Recording rule mentioning the service — must be excluded.
					Type:  "recording",
					Name:  "orders:calls:rate",
					Query: `sum(rate(calls_total{service_name="orders"}[5m]))`,
				},
			},
		},
	}

	srv := mockRulerServer(t, groups)
	defer srv.Close()
	app := newTestApp(t, srv.URL, queries.Capabilities{})

	t.Run("filters to rules mentioning the service", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/services/teamorders/orders/alerts", nil)
		req.SetPathValue("namespace", "teamorders")
		req.SetPathValue("service", "orders")
		w := httptest.NewRecorder()

		app.handleServiceAlerts(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp ServiceAlertsResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}

		// OrdersHighErrorRate (query match) + OrdersLabelMatch (label match);
		// PaymentsDown and the recording rule are excluded.
		if len(resp.Rules) != 2 {
			t.Fatalf("expected 2 rules, got %d: %+v", len(resp.Rules), resp.Rules)
		}
		// Firing sorts before inactive.
		if resp.Rules[0].Name != "OrdersHighErrorRate" || resp.Rules[0].State != "firing" {
			t.Errorf("first rule should be OrdersHighErrorRate (firing), got %s (%s)", resp.Rules[0].Name, resp.Rules[0].State)
		}
		if resp.Rules[0].Source != alertSourceMimir {
			t.Errorf("expected source %q, got %q", alertSourceMimir, resp.Rules[0].Source)
		}
		if resp.Rules[0].ActiveCount != 1 {
			t.Errorf("expected activeCount 1, got %d", resp.Rules[0].ActiveCount)
		}
		if resp.Rules[1].Name != "OrdersLabelMatch" {
			t.Errorf("second rule should be OrdersLabelMatch, got %s", resp.Rules[1].Name)
		}
	})

	t.Run("no match returns empty, not unavailable", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/services/teamorders/ghost/alerts", nil)
		req.SetPathValue("namespace", "teamorders")
		req.SetPathValue("service", "ghost")
		w := httptest.NewRecorder()

		app.handleServiceAlerts(w, req)

		var resp ServiceAlertsResponse
		_ = json.Unmarshal(w.Body.Bytes(), &resp)

		if len(resp.Rules) != 0 {
			t.Fatalf("expected 0 rules for unknown service, got %d", len(resp.Rules))
		}
		if resp.Unavailable {
			t.Error("should not be unavailable when the ruler responds")
		}
	})

	t.Run("missing service is a 400", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/services/teamorders//alerts", nil)
		req.SetPathValue("namespace", "teamorders")
		req.SetPathValue("service", "")
		w := httptest.NewRecorder()

		app.handleServiceAlerts(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for missing service, got %d", w.Code)
		}
	})
}

func TestHandleServiceAlerts_RulerUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/rules" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		resp := queries.PromResponse{
			Status: "success",
			Data:   queries.PromData{ResultType: "vector", Result: []queries.PromResult{}},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	app := newTestApp(t, srv.URL, queries.Capabilities{})

	req := httptest.NewRequest("GET", "/services/teamorders/orders/alerts", nil)
	req.SetPathValue("namespace", "teamorders")
	req.SetPathValue("service", "orders")
	w := httptest.NewRecorder()

	app.handleServiceAlerts(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 (graceful degradation), got %d", w.Code)
	}

	var resp ServiceAlertsResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)

	if !resp.Unavailable {
		t.Error("expected unavailable=true when the ruler returns 404")
	}
	if len(resp.Rules) != 0 {
		t.Errorf("expected empty rules, got %d", len(resp.Rules))
	}
}

func TestHandleServiceAlerts_FiringInstances(t *testing.T) {
	// A firing rule with two active instances (per-endpoint labels + values),
	// a pending rule, and an inactive rule. The response must carry the
	// per-instance value/labels (#33), not just the active count.
	groups := []queries.RuleGroup{
		{
			Name: "orders-alerts",
			File: "dev/teamorders/orders-alerts/abc123",
			Rules: []queries.Rule{
				{
					Type:        "alerting",
					Name:        "OrdersHighErrorRate",
					Query:       `sum(rate(calls_total{service_name="orders"}[5m])) > 0.05`,
					Duration:    300,
					State:       "firing",
					Labels:      map[string]string{"namespace": "teamorders", "severity": "critical"},
					Annotations: map[string]string{"runbook_url": "https://runbooks.example/orders"},
					Alerts: []queries.Alert{
						{
							State:    "firing",
							Value:    "0.12",
							ActiveAt: "2026-04-25T10:05:00Z",
							Labels:   map[string]string{"service_name": "orders", "endpoint": "/checkout"},
						},
						{
							State:    "firing",
							Value:    "0.08",
							ActiveAt: "2026-04-25T10:00:00Z",
							Labels:   map[string]string{"service_name": "orders", "endpoint": "/cart"},
						},
					},
				},
				{
					Type:   "alerting",
					Name:   "OrdersLatency",
					Query:  `histogram_quantile(0.95, orders_latency) > 1`,
					State:  "pending",
					Labels: map[string]string{"namespace": "teamorders", "service": "orders"},
					Alerts: []queries.Alert{
						{State: "pending", Value: "1.4", ActiveAt: "2026-04-25T11:00:00Z", Labels: map[string]string{"service_name": "orders"}},
					},
				},
				{
					Type:   "alerting",
					Name:   "OrdersDiskUsage",
					Query:  `disk{service_name="orders"} > 0.9`,
					State:  "inactive",
					Labels: map[string]string{"namespace": "teamorders"},
					Alerts: []queries.Alert{},
				},
			},
		},
	}

	srv := mockRulerServer(t, groups)
	defer srv.Close()
	app := newTestApp(t, srv.URL, queries.Capabilities{})

	req := httptest.NewRequest("GET", "/services/teamorders/orders/alerts", nil)
	req.SetPathValue("namespace", "teamorders")
	req.SetPathValue("service", "orders")
	w := httptest.NewRecorder()

	app.handleServiceAlerts(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp ServiceAlertsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	byName := map[string]AlertRuleSummary{}
	for _, r := range resp.Rules {
		byName[r.Name] = r
	}

	firing, ok := byName["OrdersHighErrorRate"]
	if !ok {
		t.Fatal("OrdersHighErrorRate missing from response")
	}
	if firing.ActiveCount != 2 {
		t.Errorf("firing activeCount = %d, want 2", firing.ActiveCount)
	}
	if len(firing.Instances) != 2 {
		t.Fatalf("firing rule should carry 2 instances, got %d", len(firing.Instances))
	}
	if firing.InstancesTruncated {
		t.Error("firing rule should not be truncated at 2 instances")
	}
	// Instances preserve value + labels + state from the ruler payload.
	var checkout *AlertInstance
	for i := range firing.Instances {
		if firing.Instances[i].Labels["endpoint"] == "/checkout" {
			checkout = &firing.Instances[i]
		}
	}
	if checkout == nil {
		t.Fatal("expected an instance with endpoint=/checkout")
	}
	if checkout.Value != "0.12" {
		t.Errorf("checkout instance value = %q, want 0.12", checkout.Value)
	}
	if checkout.State != "firing" {
		t.Errorf("checkout instance state = %q, want firing", checkout.State)
	}
	// The #32 drawer fields ride along on the summary: raw expression, the
	// `for` window (seconds), and the runbook_url annotation surfaced verbatim.
	if firing.Expression != `sum(rate(calls_total{service_name="orders"}[5m])) > 0.05` {
		t.Errorf("firing expression = %q, want the rule query", firing.Expression)
	}
	if firing.ForDuration != 300 {
		t.Errorf("firing forDuration = %v, want 300", firing.ForDuration)
	}
	if firing.RunbookURL != "https://runbooks.example/orders" {
		t.Errorf("firing runbookUrl = %q, want the runbook_url annotation", firing.RunbookURL)
	}

	pending, ok := byName["OrdersLatency"]
	if !ok {
		t.Fatal("OrdersLatency missing from response")
	}
	if len(pending.Instances) != 1 || pending.Instances[0].Value != "1.4" {
		t.Errorf("pending rule instances = %+v, want one with value 1.4", pending.Instances)
	}

	inactive, ok := byName["OrdersDiskUsage"]
	if !ok {
		t.Fatal("OrdersDiskUsage missing from response")
	}
	if len(inactive.Instances) != 0 {
		t.Errorf("inactive rule should have no instances, got %d", len(inactive.Instances))
	}
}

func TestHandleServiceAlerts_InstancesCapped(t *testing.T) {
	// A rule with more active instances than the cap must truncate the list and
	// flag it, while activeCount still reflects the full total.
	total := alertInstanceCap + 5
	alerts := make([]queries.Alert, 0, total)
	for i := 0; i < total; i++ {
		alerts = append(alerts, queries.Alert{
			State:    "firing",
			Value:    fmt.Sprintf("%d", i),
			ActiveAt: "2026-04-25T10:00:00Z",
			Labels:   map[string]string{"service_name": "orders", "shard": fmt.Sprintf("shard-%d", i)},
		})
	}
	groups := []queries.RuleGroup{
		{
			Name: "orders-alerts",
			File: "dev/teamorders/orders-alerts/abc123",
			Rules: []queries.Rule{
				{
					Type:   "alerting",
					Name:   "OrdersFanout",
					Query:  `up{service_name="orders"} == 0`,
					State:  "firing",
					Labels: map[string]string{"namespace": "teamorders"},
					Alerts: alerts,
				},
			},
		},
	}

	srv := mockRulerServer(t, groups)
	defer srv.Close()
	app := newTestApp(t, srv.URL, queries.Capabilities{})

	req := httptest.NewRequest("GET", "/services/teamorders/orders/alerts", nil)
	req.SetPathValue("namespace", "teamorders")
	req.SetPathValue("service", "orders")
	w := httptest.NewRecorder()

	app.handleServiceAlerts(w, req)

	var resp ServiceAlertsResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Rules) != 1 {
		t.Fatalf("expected 1 rule, got %d", len(resp.Rules))
	}
	r := resp.Rules[0]
	if r.ActiveCount != total {
		t.Errorf("activeCount = %d, want %d (full total)", r.ActiveCount, total)
	}
	if len(r.Instances) != alertInstanceCap {
		t.Errorf("instances = %d, want capped at %d", len(r.Instances), alertInstanceCap)
	}
	if !r.InstancesTruncated {
		t.Error("expected instancesTruncated=true when instances exceed the cap")
	}
}

func TestHandleServiceAlerts_InstancesUnavailable(t *testing.T) {
	// The degraded path (ruler unreachable) still returns cleanly with no
	// instances and the unavailable flag set.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/rules" {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		resp := queries.PromResponse{Status: "success", Data: queries.PromData{ResultType: "vector", Result: []queries.PromResult{}}}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	app := newTestApp(t, srv.URL, queries.Capabilities{})
	req := httptest.NewRequest("GET", "/services/teamorders/orders/alerts", nil)
	req.SetPathValue("namespace", "teamorders")
	req.SetPathValue("service", "orders")
	w := httptest.NewRecorder()

	app.handleServiceAlerts(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 (graceful degradation), got %d", w.Code)
	}
	var resp ServiceAlertsResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.Unavailable {
		t.Error("expected unavailable=true when the ruler errors")
	}
	if len(resp.Rules) != 0 {
		t.Errorf("expected no rules, got %d", len(resp.Rules))
	}
}

func TestHandleNamespaceAlerts_CaseInsensitive(t *testing.T) {
	groups := []queries.RuleGroup{
		{
			Name: "MyTeam-alerts",
			File: "dev/MyTeam/myteam-alerts/abc123",
			Rules: []queries.Rule{
				{
					Type:        "alerting",
					Name:        "TestAlert",
					State:       "inactive",
					Labels:      map[string]string{"namespace": "MyTeam"},
					Annotations: map[string]string{},
					Alerts:      []queries.Alert{},
				},
			},
		},
	}

	srv := mockRulerServer(t, groups)
	defer srv.Close()
	app := newTestApp(t, srv.URL, queries.Capabilities{})

	req := httptest.NewRequest("GET", "/namespaces/myteam/alerts", nil)
	req.SetPathValue("namespace", "myteam")
	w := httptest.NewRecorder()

	app.handleNamespaceAlerts(w, req)

	var resp NamespaceAlertsResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)

	if len(resp.Rules) != 1 {
		t.Fatalf("case-insensitive match should find 1 rule, got %d", len(resp.Rules))
	}
}
