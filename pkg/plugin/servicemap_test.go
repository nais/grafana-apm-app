package plugin

import (
	"testing"
	"time"
)

func TestExtractTopologyNodeName(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"empty", "", ""},
		{"simple name", "myapp", "myapp"},
		{"name with port", "mydb:5432", "mydb"},
		{"kubernetes FQDN", "myapp.myns.svc.cluster.local", "myapp"},
		{"kubernetes FQDN with port", "myapp.myns.svc.cluster.local:8080", "myapp"},
		{"short svc form", "myapp.myns.svc", "myapp"},
		{"IP address", "10.0.1.5", "10.0.1.5"},
		{"IP with port", "10.0.1.5:3306", "10.0.1.5:3306"},
		{"IP with standard port", "10.0.1.5:443", "10.0.1.5"},
		{"external host", "api.example.com", "api.example.com"},
		{"external host with port", "api.example.com:8443", "api.example.com:8443"},
		{"external host standard port", "api.example.com:443", "api.example.com"},
		{"trailing dot", "myapp.myns.svc.cluster.local.", "myapp"},
		{"uppercase", "MyApp.myns.svc.cluster.local", "myapp"},
		{"name:standard port", "myapp:80", "myapp"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := extractTopologyNodeName(tc.input)
			if got != tc.expected {
				t.Errorf("extractTopologyNodeName(%q) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestComputeRangeStr(t *testing.T) {
	now := time.Now()
	tests := []struct {
		name     string
		from     time.Time
		to       time.Time
		expected string
	}{
		{"3m window → floor at 5m", now.Add(-3 * time.Minute), now, "[5m]"},
		{"5m window → 5m", now.Add(-5 * time.Minute), now, "[5m]"},
		{"10m window → 10m", now.Add(-10 * time.Minute), now, "[10m]"},
		{"15m window → 15m", now.Add(-15 * time.Minute), now, "[15m]"},
		{"30m window → 30m", now.Add(-30 * time.Minute), now, "[30m]"},
		{"45m window → 45m", now.Add(-45 * time.Minute), now, "[45m]"},
		{"90m window → 90m", now.Add(-90 * time.Minute), now, "[90m]"},
		{"1h window → 1h", now.Add(-1 * time.Hour), now, "[1h]"},
		{"2h window → 2h", now.Add(-2 * time.Hour), now, "[2h]"},
		{"6h window → 6h", now.Add(-6 * time.Hour), now, "[6h]"},
		{"24h window → 24h", now.Add(-24 * time.Hour), now, "[24h]"},
		{"7d window → 24h cap", now.Add(-7 * 24 * time.Hour), now, "[24h]"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := computeRangeStr(tc.from, tc.to)
			if got != tc.expected {
				t.Errorf("computeRangeStr(%v, %v) = %q, want %q", tc.from, tc.to, got, tc.expected)
			}
		})
	}
}
