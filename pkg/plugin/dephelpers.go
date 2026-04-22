package plugin

import (
	"regexp"
	"strings"
)

// addressMatchRegex returns a PromQL regex pattern that matches both the
// normalized address form (as shown in the UI) and the raw metric label value.
// e.g., "idporten.no" → `idporten\\.no(:(443|80))?` (matches idporten.no, idporten.no:443, idporten.no:80)
// e.g., "db:5432" → `db:5432` (non-standard port, exact match)
//
// The result is double-escaped: regexp.QuoteMeta produces \. but PromQL
// double-quoted strings require \\\\ to represent a literal backslash.
// Without double-escaping, Prometheus rejects the query with
// "unknown escape sequence U+002E '.'".
func addressMatchRegex(normalized string) string {
	host, port, hasPort := strings.Cut(normalized, ":")
	escaped := promQLEscape(host)
	if hasPort {
		return escaped + ":" + promQLEscape(port)
	}
	return escaped + "(:(443|80))?"
}

// promQLEscape escapes a string for use in a PromQL regex inside double quotes.
// First escapes regex metacharacters, then doubles backslashes for PromQL string syntax.
func promQLEscape(s string) string {
	return strings.ReplaceAll(regexp.QuoteMeta(s), `\`, `\\`)
}

// normalizeAddress cleans up a server address / http_host value for display.
// It strips well-known ports (:443, :80) and trailing dots.
func normalizeAddress(addr string) string {
	if addr == "" {
		return ""
	}
	// Split host:port, strip trailing dot from host, then handle ports
	host, port, hasPort := strings.Cut(addr, ":")
	host = strings.TrimRight(host, ".")
	if hasPort {
		switch port {
		case "443", "80":
			return strings.ToLower(host)
		}
		return strings.ToLower(host + ":" + port)
	}
	return strings.ToLower(host)
}

// coalesceAddress returns a normalized address from server_address / http_host labels.
// Prefers server_address; falls back to http_host.
func coalesceAddress(serverAddress, httpHost string) string {
	if serverAddress != "" {
		return normalizeAddress(serverAddress)
	}
	return normalizeAddress(httpHost)
}

// depKey uniquely identifies a dependency by server name and connection type.
type depKey struct {
	server   string
	connType string
}

// depData holds aggregated metrics for a single dependency.
type depData struct {
	rate      float64
	errorRate float64
	p95       float64
}
