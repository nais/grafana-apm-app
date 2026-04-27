package otelconfig

import "testing"

func TestAlloyFilter(t *testing.T) {
	cfg := Default()

	tests := []struct {
		name        string
		service     string
		environment string
		want        string
	}{
		{
			name:    "service only",
			service: "my-app",
			want:    `app_name="my-app", job="alloy-faro"`,
		},
		{
			name:        "service with environment",
			service:     "my-app",
			environment: "dev",
			want:        `app_name="my-app", job="alloy-faro", k8s_cluster_name="dev"`,
		},
		{
			name:        "empty environment is omitted",
			service:     "frontend-app",
			environment: "",
			want:        `app_name="frontend-app", job="alloy-faro"`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := cfg.AlloyFilter(tc.service, tc.environment)
			if got != tc.want {
				t.Errorf("AlloyFilter(%q, %q) = %q, want %q", tc.service, tc.environment, got, tc.want)
			}
		})
	}
}

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
