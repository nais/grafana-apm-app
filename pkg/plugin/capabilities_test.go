package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// fakeDatasourcesServer returns a test server that serves the given datasource
// list from GET /api/datasources, mimicking Grafana's internal API. When
// status is non-2xx it returns that status with no body.
func fakeDatasourcesServer(t *testing.T, datasources []map[string]string, status int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/datasources" {
			http.NotFound(w, r)
			return
		}
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(datasources)
	}))
}

func pyroscopeTestApp(baseURL string) *App {
	return &App{
		grafanaURL:   baseURL,
		healthClient: &http.Client{Timeout: 5 * time.Second},
	}
}

func TestDetectPyroscope(t *testing.T) {
	tests := []struct {
		name          string
		datasources   []map[string]string
		wantAvailable bool
		wantUID       string
	}{
		{
			name: "current pyroscope datasource type detected",
			datasources: []map[string]string{
				{"uid": "prom-uid", "type": "prometheus"},
				{"uid": "pyro-uid", "type": "grafana-pyroscope-datasource"},
			},
			wantAvailable: true,
			wantUID:       "pyro-uid",
		},
		{
			name: "legacy phlare datasource type detected",
			datasources: []map[string]string{
				{"uid": "phlare-uid", "type": "phlare"},
			},
			wantAvailable: true,
			wantUID:       "phlare-uid",
		},
		{
			name: "no profiling datasource — unavailable (the production reality)",
			datasources: []map[string]string{
				{"uid": "prom-uid", "type": "prometheus"},
				{"uid": "tempo-uid", "type": "tempo"},
				{"uid": "loki-uid", "type": "loki"},
			},
			wantAvailable: false,
		},
		{
			name:          "empty datasource list — unavailable",
			datasources:   []map[string]string{},
			wantAvailable: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := fakeDatasourcesServer(t, tc.datasources, http.StatusOK)
			defer srv.Close()

			app := pyroscopeTestApp(srv.URL)
			got := app.detectPyroscope(context.Background(), http.Header{}, "")

			if got.Available != tc.wantAvailable {
				t.Errorf("Available = %v, want %v", got.Available, tc.wantAvailable)
			}
			if got.UID != tc.wantUID {
				t.Errorf("UID = %q, want %q", got.UID, tc.wantUID)
			}
		})
	}
}

func TestDetectPyroscopeDegradesToUnavailable(t *testing.T) {
	t.Run("no grafana URL configured", func(t *testing.T) {
		app := pyroscopeTestApp("")
		got := app.detectPyroscope(context.Background(), http.Header{}, "")
		if got.Available {
			t.Errorf("expected unavailable when grafanaURL empty, got %+v", got)
		}
	})

	t.Run("non-2xx from datasources API", func(t *testing.T) {
		srv := fakeDatasourcesServer(t, nil, http.StatusForbidden)
		defer srv.Close()

		app := pyroscopeTestApp(srv.URL)
		got := app.detectPyroscope(context.Background(), http.Header{}, "")
		if got.Available {
			t.Errorf("expected unavailable on HTTP 403, got %+v", got)
		}
	})

	t.Run("transport error (dead server)", func(t *testing.T) {
		srv := fakeDatasourcesServer(t, nil, http.StatusOK)
		url := srv.URL
		srv.Close() // close immediately so the request fails to connect

		app := pyroscopeTestApp(url)
		got := app.detectPyroscope(context.Background(), http.Header{}, "")
		if got.Available {
			t.Errorf("expected unavailable on transport error, got %+v", got)
		}
	})
}

func TestDetectPyroscopeForwardsServiceToken(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]map[string]string{
			{"uid": "pyro-uid", "type": "grafana-pyroscope-datasource"},
		})
	}))
	defer srv.Close()

	app := pyroscopeTestApp(srv.URL)
	got := app.detectPyroscope(context.Background(), http.Header{}, "svc-token-123")

	if !got.Available || got.UID != "pyro-uid" {
		t.Fatalf("expected available pyro-uid, got %+v", got)
	}
	if gotAuth != "Bearer svc-token-123" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer svc-token-123")
	}
}
