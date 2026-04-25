package plugin

import (
	"encoding/json"
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
		{"myteam/alerts.yaml", "myteam"},
		{"nais-system/sla-rules.yml", "nais-system"},
		{"alerts.yaml", ""},
		{"", ""},
		{"a/b/c.yaml", "a"},
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
			File: "myteam/alerts.yaml",
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
			},
		},
		{
			Name: "otherteam-alerts",
			File: "otherteam/alerts.yaml",
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
			File: "myteam/infra.yaml",
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

		// Should get 3 rules: HighErrorRate (firing), PodCrashLoop (pending, via file path), DiskUsage (inactive)
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

func TestHandleNamespaceAlerts_CaseInsensitive(t *testing.T) {
	groups := []queries.RuleGroup{
		{
			Name: "MyTeam-alerts",
			File: "MyTeam/alerts.yaml",
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
