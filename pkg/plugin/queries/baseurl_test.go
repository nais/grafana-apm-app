package queries

import (
	"context"
	"testing"
	"time"
)

func TestSafeBaseURL(t *testing.T) {
	for in, want := range map[string]string{
		"": "",
		"http://localhost:3000/api/datasources/proxy/uid/abc-1_X/":    "http://localhost:3000/api/datasources/proxy/uid/abc-1_X",
		"http://127.0.0.1:3000/api/prometheus/grafana":                "http://127.0.0.1:3000/api/prometheus/grafana",
		"https://grafana.example.com/api/prometheus/grafana":          "https://grafana.example.com/api/prometheus/grafana",
		"http://localhost:3000/grafana/api/datasources/proxy/uid/abc": "http://localhost:3000/grafana/api/datasources/proxy/uid/abc",
		"http://localhost:3000/api/datasources/proxy/uid/x?y=1":       "",
		"http://evil@attacker.example/":                               "",
		"http://localhost:3000/api/datasources/proxy/uid/a#b":         "",
		"http://localhost:3000/api/../x":                              "",
		"file:///etc/passwd":                                          "",
	} {
		if got := safeBaseURL(in); got != want {
			t.Errorf("safeBaseURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLokiMetricClientBaseURL(t *testing.T) {
	c := NewLokiMetricClient("http://localhost:3000/api/datasources/proxy/uid/abc/", "")
	if want := "http://localhost:3000/api/datasources/proxy/uid/abc/loki"; c.baseURL != want {
		t.Errorf("baseURL = %q, want %q", c.baseURL, want)
	}
}

func TestRejectedClientQueryFails(t *testing.T) {
	c := NewPrometheusClient("http://evil@attacker.example/", "")
	if _, err := c.InstantQuery(context.Background(), "up", time.Now()); err == nil {
		t.Fatal("expected error from client with rejected base URL")
	}
}
