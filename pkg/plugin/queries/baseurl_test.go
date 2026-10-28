package queries

import "testing"

func TestSafeBaseURL(t *testing.T) {
	for in, want := range map[string]string{
		"http://localhost:3000/api/datasources/proxy/uid/abc-1_X/": "http://localhost:3000/api/datasources/proxy/uid/abc-1_X",
		"http://127.0.0.1:3000/api/prometheus/grafana":             "http://127.0.0.1:3000/api/prometheus/grafana",
		"http://localhost:3000/api/datasources/proxy/uid/x?y=1":    "",
		"http://evil@attacker.example/":                            "",
		"http://localhost:3000/api/datasources/proxy/uid/a#b":      "",
		"file:///etc/passwd":                                       "",
	} {
		if got := safeBaseURL(in); got != want {
			t.Errorf("safeBaseURL(%q) = %q, want %q", in, got, want)
		}
	}
}
