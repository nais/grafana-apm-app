package queries

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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
			for _, location := range []string{target.URL + "/private", "/outside-proxy", "//" + target.Listener.Addr().String() + "/private", "http://user:password@" + target.Listener.Addr().String() + "/private", "/%zz?token=secret-location"} {
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
						if err := call(); err == nil || !strings.Contains(err.Error(), fmt.Sprintf("redirect response rejected (HTTP %d)", status)) || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "password") {
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
			if err == nil || !strings.Contains(err.Error(), "redirect response rejected (HTTP 307)") || strings.Contains(err.Error(), "secret") {
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

func TestQueryClientsRejectStreamingRedirects(t *testing.T) {
	for _, token := range []string{"", "service-token"} {
		for _, location := range []string{"/outside?token=secret-location", "/%zz?token=secret-location", ""} {
			t.Run(fmt.Sprintf("token=%s/location=%s", token, location), func(t *testing.T) {
				var escaped atomic.Int32
				proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/outside" {
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
					if token == "" && r.Header.Get("Cookie") != "session=test" {
						t.Error("missing forwarded cookie")
					}
					w.Header().Set("Location", location)
					w.WriteHeader(http.StatusTemporaryRedirect)
					w.(http.Flusher).Flush()
					<-r.Context().Done()
				}))
				defer proxy.Close()
				headers := http.Header{"Authorization": {"Bearer user-token"}, "Cookie": {"session=test"}}
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				for _, constructor := range []func(string, string) *PrometheusClient{NewPrometheusClient, NewLokiMetricClient} {
					client := constructor(proxy.URL, token).WithAuthHeaders(headers)
					calls := []func() error{
						func() error { _, err := client.InstantQuery(ctx, "up", time.Now()); return err },
						func() error { _, err := client.RangeQuery(ctx, "up", time.Now(), time.Now(), time.Minute); return err },
						func() error { _, err := client.GetAlertRules(ctx); return err },
						func() error { _, err := client.LabelValues(ctx, "service_name", time.Time{}, time.Time{}); return err },
						func() error { _, err := client.Metadata(ctx, "up"); return err },
					}
					for _, call := range calls {
						assertQuickRedirectError(t, call)
					}
				}
				ds := NewDsQueryClient(proxy.URL, token).WithAuthHeaders(headers)
				assertQuickRedirectError(t, func() error {
					_, err := ds.InstantQuery(ctx, "uid", "up", time.Now())
					return err
				})
				if escaped.Load() != 0 {
					t.Fatal("redirect escaped configured endpoint")
				}
			})
		}
	}
}

func assertQuickRedirectError(t *testing.T, call func() error) {
	t.Helper()
	start := time.Now()
	err := call()
	if err == nil || !strings.Contains(err.Error(), "redirect response rejected (HTTP 307)") || strings.Contains(err.Error(), "secret") {
		t.Errorf("expected sanitized redirect error, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("redirect rejection took %s", elapsed)
	}
}
