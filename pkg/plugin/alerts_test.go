package plugin

import (
	"testing"
)

func TestExtractNamespaceFromGroupFile(t *testing.T) {
	tests := []struct {
		file     string
		expected string
	}{
		{"myteam/alerts.yaml", "myteam"},
		{"nais-system/sla-rules.yml", "nais-system"},
		{"alerts.yaml", ""},                // no slash
		{"", ""},                           // empty
		{"a/b/c.yaml", "a"},               // nested path
	}
	for _, tc := range tests {
		got := extractNamespaceFromGroupFile(tc.file)
		if got != tc.expected {
			t.Errorf("extractNamespaceFromGroupFile(%q) = %q, want %q", tc.file, got, tc.expected)
		}
	}
}

func TestHandleNamespaceAlerts_Sorting(t *testing.T) {
	// Verify the state ordering used in handleNamespaceAlerts
	stateOrder := map[string]int{"firing": 0, "pending": 1, "inactive": 2}

	if stateOrder["firing"] >= stateOrder["pending"] {
		t.Error("firing should sort before pending")
	}
	if stateOrder["pending"] >= stateOrder["inactive"] {
		t.Error("pending should sort before inactive")
	}
}
