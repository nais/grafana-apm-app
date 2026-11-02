package plugin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
)

func TestTempoClientsRejectRedirects(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		for _, token := range []string{"", "service-token"} {
			var escaped atomic.Int32
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/outside") {
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
				w.Header().Set("Location", "/outside?token=secret-location")
				w.WriteHeader(status)
				_, _ = w.Write([]byte("secret-body"))
			}))
			headers := http.Header{"Authorization": {"Bearer user-token"}, "Cookie": {"session=test"}}
			app := &App{grafanaURL: proxy.URL, serviceToken: token, otelCfg: otelconfig.Default()}
			tempo := newTempoQueryClient(proxy.URL, token, headers)
			calls := []func() error{
				func() error {
					_, err := tempo.metricQuery(context.Background(), "uid", "{} | count_over_time()", "1m", time.Now(), time.Now())
					return err
				},
				func() error {
					_, _, err := app.searchDBSpans(context.Background(), headers, "uid", "ns", "svc", time.Now(), time.Now())
					return err
				},
				func() error {
					_, _, err := app.searchNPlusOneTraces(context.Background(), headers, "uid", "ns", "svc", time.Now(), time.Now())
					return err
				},
			}
			for i, call := range calls {
				err := call()
				if err == nil || strings.Contains(err.Error(), "secret") {
					t.Errorf("client %d: expected sanitized redirect error, got %v", i, err)
				}
			}
			proxy.Close()
			if escaped.Load() != 0 {
				t.Fatal("redirect escaped configured endpoint")
			}
		}
	}
}
