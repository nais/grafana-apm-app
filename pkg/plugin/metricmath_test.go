package plugin

import (
	"math"
	"testing"
)

func TestIsValidMetricValue(t *testing.T) {
	tests := []struct {
		name  string
		value float64
		want  bool
	}{
		{"positive", 42.0, true},
		{"zero", 0, true},
		{"negative", -1.5, true},
		{"NaN", math.NaN(), false},
		{"positive Inf", math.Inf(1), false},
		{"negative Inf", math.Inf(-1), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isValidMetricValue(tt.value); got != tt.want {
				t.Errorf("isValidMetricValue(%v) = %v, want %v", tt.value, got, tt.want)
			}
		})
	}
}

func TestCalculateErrorRate(t *testing.T) {
	tests := []struct {
		name      string
		errorVal  float64
		totalRate float64
		want      float64
	}{
		{"normal", 5, 100, 5.0},
		{"zero total rate", 5, 0, 0},
		{"negative total rate", 5, -1, 0},
		{"zero errors", 0, 100, 0},
		{"capped at 100", 150, 100, 100},
		{"NaN error", math.NaN(), 100, 0},
		{"NaN total", 5, math.NaN(), 0},
		{"Inf error", math.Inf(1), 100, 0},
		{"small values", 0.001, 10, 0.01},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := calculateErrorRate(tt.errorVal, tt.totalRate)
			if got != tt.want {
				t.Errorf("calculateErrorRate(%v, %v) = %v, want %v", tt.errorVal, tt.totalRate, got, tt.want)
			}
		})
	}
}
