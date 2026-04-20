package plugin

import (
	"context"
	"net/http"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

type mockCallResourceResponseSender struct {
	response *backend.CallResourceResponse
}

func (s *mockCallResourceResponseSender) Send(response *backend.CallResourceResponse) error {
	s.response = response
	return nil
}

func TestCallResource(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app, ok := inst.(*App)
	if !ok {
		t.Fatal("inst must be of type *App")
	}

	for _, tc := range []struct {
		name      string
		method    string
		path      string
		expStatus int
	}{
		{
			name:      "get ping 200",
			method:    http.MethodGet,
			path:      "ping",
			expStatus: http.StatusOK,
		},
		{
			name:      "get capabilities 200",
			method:    http.MethodGet,
			path:      "capabilities",
			expStatus: http.StatusOK,
		},
		{
			name:      "get services 503 when unconfigured",
			method:    http.MethodGet,
			path:      "services",
			expStatus: http.StatusServiceUnavailable,
		},
		{
			name:      "get services with namespace filter 503 when unconfigured",
			method:    http.MethodGet,
			path:      "services?namespace=otel-demo",
			expStatus: http.StatusServiceUnavailable,
		},
		{
			name:      "get services with environment filter 503 when unconfigured",
			method:    http.MethodGet,
			path:      "services?environment=production",
			expStatus: http.StatusServiceUnavailable,
		},
		{
			name:      "get service-map 200",
			method:    http.MethodGet,
			path:      "service-map",
			expStatus: http.StatusOK,
		},
		{
			name:      "get service-map with service filter 200",
			method:    http.MethodGet,
			path:      "service-map?service=frontend&namespace=otel-demo",
			expStatus: http.StatusOK,
		},
		{
			name:      "get operations 200",
			method:    http.MethodGet,
			path:      "services/demo/frontend/operations",
			expStatus: http.StatusOK,
		},
		{
			name:      "get dependencies 200",
			method:    http.MethodGet,
			path:      "services/demo/frontend/dependencies",
			expStatus: http.StatusOK,
		},
		{
			name:      "get connected services 200",
			method:    http.MethodGet,
			path:      "services/demo/frontend/connected",
			expStatus: http.StatusOK,
		},
		{
			name:      "get global dependencies 200",
			method:    http.MethodGet,
			path:      "dependencies",
			expStatus: http.StatusOK,
		},
		{
			name:      "get dependency detail 200",
			method:    http.MethodGet,
			path:      "dependencies/redis",
			expStatus: http.StatusOK,
		},
		{
			name:      "get non existing handler 404",
			method:    http.MethodGet,
			path:      "not_found",
			expStatus: http.StatusNotFound,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var r mockCallResourceResponseSender
			err = app.CallResource(context.Background(), &backend.CallResourceRequest{
				Method: tc.method,
				Path:   tc.path,
			}, &r)
			if err != nil {
				t.Fatalf("CallResource error: %s", err)
			}
			if r.response == nil {
				t.Fatal("no response received from CallResource")
			}
			if tc.expStatus > 0 && tc.expStatus != r.response.Status {
				t.Errorf("response status should be %d, got %d", tc.expStatus, r.response.Status)
			}
		})
	}
}
