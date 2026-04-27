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
