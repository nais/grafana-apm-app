package plugin

import "math"

// isValidMetricValue returns true if the value is a finite number (not NaN or ±Inf).
func isValidMetricValue(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

// safeFloat returns 0 for NaN/Inf values, coercing invalid metrics to a safe zero.
func safeFloat(v float64) float64 {
	if !isValidMetricValue(v) {
		return 0
	}
	return v
}

// calculateErrorRate computes an error percentage from an error count rate and
// total request rate. Returns 0 when the total rate is not positive. The result
// is clamped to [0, 100].
func calculateErrorRate(errorVal, totalRate float64) float64 {
	if totalRate <= 0 || !isValidMetricValue(errorVal) || !isValidMetricValue(totalRate) {
		return 0
	}
	return math.Min(roundTo(errorVal/totalRate*100, 2), 100)
}
