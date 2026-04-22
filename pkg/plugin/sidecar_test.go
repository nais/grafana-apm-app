package plugin

import "testing"

func TestIsSidecar(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"wonderwall", true},
		{"texas", true},
		{"Wonderwall", true},  // case-insensitive
		{"TEXAS", true},       // case-insensitive
		{" wonderwall ", true}, // trimmed
		{"my-app", false},
		{"wonderwall-proxy", false}, // not an exact match
		{"", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isSidecar(tt.name); got != tt.want {
				t.Errorf("isSidecar(%q) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}
