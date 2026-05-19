package otelconfig

import "testing"

func TestServiceFilter(t *testing.T) {
	cfg := Default()

	tests := []struct {
		name      string
		service   string
		namespace string
		want      string
	}{
		{
			name:    "service only",
			service: "my-svc",
			want:    `service_name="my-svc"`,
		},
		{
			name:      "service with namespace",
			service:   "my-svc",
			namespace: "my-ns",
			want:      `service_name="my-svc", service_namespace="my-ns"`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := cfg.ServiceFilter(tc.service, tc.namespace)
			if got != tc.want {
				t.Errorf("ServiceFilter(%q, %q) = %q, want %q", tc.service, tc.namespace, got, tc.want)
			}
		})
	}
}

func TestLokiStreamSelector(t *testing.T) {
	cfg := Default()

	tests := []struct {
		name    string
		service string
		kind    string
		cluster string
		want    string
	}{
		{
			name:    "service and kind only",
			service: "my-app",
			kind:    "measurement",
			want:    `{service_name="my-app", kind="measurement"}`,
		},
		{
			name:    "without kind",
			service: "my-app",
			want:    `{service_name="my-app"}`,
		},
		{
			name:    "with cluster filter",
			service: "my-app",
			kind:    "measurement",
			cluster: "prod-gcp",
			want:    `{service_name="my-app", kind="measurement", k8s_cluster_name="prod-gcp"}`,
		},
		{
			name:    "empty cluster is ignored",
			service: "my-app",
			kind:    "exception",
			cluster: "",
			want:    `{service_name="my-app", kind="exception"}`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := cfg.LokiStreamSelector(tc.service, tc.kind, tc.cluster)
			if got != tc.want {
				t.Errorf("LokiStreamSelector() = %q, want %q", got, tc.want)
			}
		})
	}
}
