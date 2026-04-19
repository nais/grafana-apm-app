package queries

import (
	"fmt"
	"regexp"
)

// safeLabel matches valid PromQL label values: alphanumeric, dots, dashes, underscores, slashes, spaces, colons.
var safeLabel = regexp.MustCompile(`^[a-zA-Z0-9._\-/ :@]+$`)

// SanitizeLabel validates a user-supplied string for safe use in PromQL label matchers.
// Returns the sanitized value or an error if the input contains unsafe characters.
func SanitizeLabel(s string) (string, error) {
	if s == "" {
		return s, nil
	}
	if len(s) > 256 {
		return "", fmt.Errorf("label value too long: %d chars (max 256)", len(s))
	}
	if !safeLabel.MatchString(s) {
		return "", fmt.Errorf("invalid label value: %q", s)
	}
	return s, nil
}

// MustSanitizeLabel validates and returns the label value, returning empty string on failure.
// Use when the label is optional and an invalid value should simply be ignored.
func MustSanitizeLabel(s string) string {
	v, err := SanitizeLabel(s)
	if err != nil {
		return ""
	}
	return v
}
