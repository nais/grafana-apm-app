package plugin

import "testing"

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
