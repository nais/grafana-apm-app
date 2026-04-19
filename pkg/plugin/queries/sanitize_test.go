package queries

import (
	"testing"
)

func TestSanitizeLabel(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{"empty", "", "", false},
		{"simple", "my-service", "my-service", false},
		{"namespace", "opentelemetry-demo", "opentelemetry-demo", false},
		{"dots", "com.example.service", "com.example.service", false},
		{"slashes", "api/v1/users", "api/v1/users", false},
		{"spaces", "my service", "my service", false},
		{"colons", "host:port", "host:port", false},
		{"at sign", "user@host", "user@host", false},
		{"underscores", "my_service_name", "my_service_name", false},
		{"mixed", "otel-demo/frontend-proxy:8080", "otel-demo/frontend-proxy:8080", false},

		// Injection attempts
		{"injection_quote", `foo"}) or vector(1) #`, "", true},
		{"injection_backtick", "foo`bar", "", true},
		{"injection_brace", "foo{bar}", "", true},
		{"injection_paren", "foo(bar)", "", true},
		{"injection_pipe", "foo|bar", "", true},
		{"injection_semicolon", "foo;bar", "", true},
		{"injection_newline", "foo\nbar", "", true},
		{"injection_tab", "foo\tbar", "", true},
		{"injection_backslash", `foo\bar`, "", true},
		{"too_long", string(make([]byte, 257)), "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := SanitizeLabel(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Errorf("SanitizeLabel(%q) should have returned an error", tt.input)
				}
				return
			}
			if err != nil {
				t.Errorf("SanitizeLabel(%q) unexpected error: %v", tt.input, err)
				return
			}
			if got != tt.want {
				t.Errorf("SanitizeLabel(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestMustSanitizeLabel(t *testing.T) {
	if v := MustSanitizeLabel("good-value"); v != "good-value" {
		t.Errorf("MustSanitizeLabel(good) = %q, want %q", v, "good-value")
	}
	if v := MustSanitizeLabel(`bad"value`); v != "" {
		t.Errorf("MustSanitizeLabel(bad) = %q, want empty", v)
	}
}
