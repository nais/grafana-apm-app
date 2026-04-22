package plugin

import (
	"net/http"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
)

func TestFormatSpanKind(t *testing.T) {
	cfg := otelconfig.Default()
	tests := []struct {
		input    string
		expected string
	}{
		{"SPAN_KIND_SERVER", "Server"},
		{"SPAN_KIND_CLIENT", "Client"},
		{"SPAN_KIND_PRODUCER", "Producer"},
		{"SPAN_KIND_CONSUMER", "Consumer"},
		{"SPAN_KIND_INTERNAL", "Internal"},
		{"UNKNOWN", "UNKNOWN"},
		{"", ""},
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			got := cfg.FormatSpanKind(tc.input)
			if got != tc.expected {
				t.Errorf("FormatSpanKind(%q) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestRoundTo(t *testing.T) {
	tests := []struct {
		val      float64
		decimals int
		expected float64
	}{
		{1.2345, 2, 1.23},
		{1.2355, 2, 1.24},
		{0.0, 3, 0.0},
		{100.999, 0, 101},
	}

	for _, tc := range tests {
		got := roundTo(tc.val, tc.decimals)
		if got != tc.expected {
			t.Errorf("roundTo(%f, %d) = %f, want %f", tc.val, tc.decimals, got, tc.expected)
		}
	}
}

func TestLabelFilterStr(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"", ""},
		{`client="frontend"`, `{client="frontend"}`},
	}

	for _, tc := range tests {
		got := labelFilterStr(tc.input)
		if got != tc.expected {
			t.Errorf("labelFilterStr(%q) = %q, want %q", tc.input, got, tc.expected)
		}
	}
}

func TestParseUnixParam(t *testing.T) {
	defaultTime := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	tests := []struct {
		name     string
		query    string
		expected time.Time
	}{
		{"valid timestamp", "?from=1700000000", time.Unix(1700000000, 0)},
		{"empty value returns default", "?from=", defaultTime},
		{"missing param returns default", "", defaultTime},
		{"non-numeric returns default", "?from=abc", defaultTime},
		{"zero timestamp", "?from=0", time.Unix(0, 0)},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodGet, "http://example.com/"+tc.query, nil)
			got := parseUnixParam(req, "from", defaultTime)
			if !got.Equal(tc.expected) {
				t.Errorf("parseUnixParam() = %v, want %v", got, tc.expected)
			}
		})
	}
}

func TestAddressMatchRegex(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"bare domain", "idporten.no", `idporten\\.no(:(443|80))?`},
		{"domain with dot", "some.host.example.com", `some\\.host\\.example\\.com(:(443|80))?`},
		{"non-standard port preserved", "postgres-ha:5432", `postgres-ha:5432`},
		{"ip address", "10.0.0.1", `10\\.0\\.0\\.1(:(443|80))?`},
		{"ip with port", "10.0.0.1:5432", `10\\.0\\.0\\.1:5432`},
		{"simple name", "kafka", `kafka(:(443|80))?`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := addressMatchRegex(tc.input)
			if got != tc.expected {
				t.Errorf("addressMatchRegex(%q) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}
