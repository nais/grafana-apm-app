package plugin

import "testing"

func TestEnvMatcher(t *testing.T) {
	tests := []struct {
		label string
		envs  string
		want  string
	}{
		{"deployment_environment", "", ""},
		{"deployment_environment", "prod", `deployment_environment="prod"`},
		{"deployment_environment", "prod,prod-fss", `deployment_environment=~"prod|prod-fss"`},
		{"k8s_cluster_name", "dev,dev-fss,prod", `k8s_cluster_name=~"dev|dev-fss|prod"`},
	}
	for _, tt := range tests {
		t.Run(tt.envs, func(t *testing.T) {
			got := envMatcher(tt.label, tt.envs)
			if got != tt.want {
				t.Errorf("envMatcher(%q, %q) = %q, want %q", tt.label, tt.envs, got, tt.want)
			}
		})
	}
}
