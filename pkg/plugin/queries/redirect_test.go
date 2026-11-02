package queries

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestQueryClientsRejectRedirects(t *testing.T) {
	var escaped atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		escaped.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()

	for _, constructor := range []struct {
		name string
		new  func(string, string) *PrometheusClient
	}{
		{"prometheus", NewPrometheusClient},
		{"loki", NewLokiMetricClient},
	} {
		for _, status := range []int{301, 302, 303, 307, 308} {
			for _, location := range []string{target.URL + "/private", "/outside-proxy", "//" + target.Listener.Addr().String() + "/private", "http://user:password@" + target.Listener.Addr().String() + "/private"} {
				t.Run(fmt.Sprintf("%s/%d/%s", constructor.name, status, location), func(t *testing.T) {
					var proxied atomic.Int32
					proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.URL.Path == "/outside-proxy" {
							escaped.Add(1)
							w.WriteHeader(http.StatusNoContent)
							return
						}
						proxied.Add(1)
						if r.Header.Get("Authorization") != "Bearer test-token" || r.Header.Get("X-Grafana-Org-Id") != "2" {
							t.Error("proxy request lost authentication")
						}
						w.Header().Set("Location", location)
						w.WriteHeader(status)
						_, _ = w.Write([]byte("sensitive-redirect-body"))
					}))
					defer proxy.Close()
					client := constructor.new(proxy.URL+"/grafana/api/datasources/proxy/uid/test", "old-token").WithServiceToken("test-token").WithAuthHeaders(http.Header{"X-Grafana-Org-Id": {"2"}})
					calls := []func() error{
						func() error { _, err := client.InstantQuery(context.Background(), "up", time.Now()); return err },
						func() error {
							_, err := client.RangeQuery(context.Background(), "up", time.Now(), time.Now(), time.Minute)
							return err
						},
						func() error { _, err := client.GetAlertRules(context.Background()); return err },
						func() error {
							_, err := client.LabelValues(context.Background(), "service_name", time.Time{}, time.Time{})
							return err
						},
						func() error { _, err := client.Metadata(context.Background(), "up"); return err },
					}
					for _, call := range calls {
						if err := call(); err == nil || err.Error() != fmt.Sprintf("redirect response rejected (HTTP %d)", status) {
							t.Errorf("expected status-only redirect error, got %v", err)
						}
					}
					if got := proxied.Load(); got != int32(len(calls)) {
						t.Errorf("proxy requests = %d, want %d", got, len(calls))
					}
				})
			}
		}
	}
	if got := escaped.Load(); got != 0 {
		t.Fatalf("redirects escaped the proxy: %d requests", got)
	}
}

func TestDsQueryRejectsRedirect(t *testing.T) {
	for _, token := range []string{"", "service-token"} {
		t.Run("token="+token, func(t *testing.T) {
			var escaped atomic.Int32
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/ds/query" {
					escaped.Add(1)
					return
				}
				want := "Bearer user-token"
				if token != "" {
					want = "Bearer " + token
				}
				if r.Header.Get("Authorization") != want {
					t.Error("missing initial authentication")
				}
				w.Header().Set("Location", "/secret-location?token=secret")
				w.WriteHeader(http.StatusTemporaryRedirect)
				_, _ = w.Write([]byte("secret-body"))
			}))
			defer proxy.Close()
			client := NewDsQueryClient(proxy.URL, token).WithAuthHeaders(http.Header{"Authorization": {"Bearer user-token"}, "Cookie": {"session=test"}})
			_, err := client.InstantQuery(context.Background(), "uid", "up", time.Now())
			if err == nil || err.Error() != "redirect response rejected (HTTP 307)" {
				t.Fatalf("expected status-only redirect error, got %v", err)
			}
			if escaped.Load() != 0 {
				t.Fatal("request escaped fixed Grafana endpoint")
			}
		})
	}
}

func TestQueryInputCannotChangeTarget(t *testing.T) {
	const input = "http://169.254.169.254/latest/meta-data/?x=1#fragment&query=other"
	var requests atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path != "/grafana/api/datasources/proxy/uid/test/api/v1/query" || r.URL.Query().Get("query") != input {
			t.Errorf("input changed proxy path or query: %s", r.URL)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	}))
	defer proxy.Close()
	client := NewPrometheusClient(proxy.URL+"/grafana/api/datasources/proxy/uid/test", "").WithAuthHeaders(http.Header{
		"Host": {"169.254.169.254"}, "X-Forwarded-Host": {"attacker.example"}, "Location": {input},
	})
	if _, err := client.InstantQuery(context.Background(), input, time.Now()); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 1 {
		t.Fatal("expected exactly one request to configured proxy")
	}
}
