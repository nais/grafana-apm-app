package plugin

import "math"

// isValidMetricValue returns true if the value is a finite number (not NaN or ±Inf).
func isValidMetricValue(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
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
