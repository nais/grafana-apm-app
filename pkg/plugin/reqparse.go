package plugin

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// parseServiceRef extracts namespace and service from path parameters.
// Namespace uses ParseNamespace (converts "_" placeholder to "").
func parseServiceRef(req *http.Request) (namespace, service string) {
	return queries.ParseNamespace(req.PathValue("namespace")),
		queries.MustSanitizeLabel(req.PathValue("service"))
}

// parseEnvironment extracts the optional environment query parameter.
// Supports comma-separated values for multi-select (e.g. "prod,prod-fss").
func parseEnvironment(req *http.Request) string {
	raw := req.URL.Query().Get("environment")
	if raw == "" {
		return ""
	}
	parts := strings.Split(raw, ",")
	var sanitized []string
	for _, p := range parts {
		s := queries.MustSanitizeLabel(strings.TrimSpace(p))
		if s != "" {
			sanitized = append(sanitized, s)
		}
	}
	return strings.Join(sanitized, ",")
}

// envMatcher builds a PromQL label matcher for one or more comma-separated
// environment values. Returns:
//   - "" if envs is empty
//   - `label="value"` for a single environment
//   - `label=~"val1|val2"` for multiple environments
func envMatcher(label, envs string) string {
	if envs == "" {
		return ""
	}
	parts := strings.Split(envs, ",")
	if len(parts) == 1 {
		return fmt.Sprintf(`%s="%s"`, label, parts[0])
	}
	return fmt.Sprintf(`%s=~"%s"`, label, strings.Join(parts, "|"))
}

// parseTimeRange extracts from/to timestamps from query parameters,
// defaulting to the last hour.
func parseTimeRange(req *http.Request) (from, to time.Time) {
	now := time.Now()
	return parseUnixParam(req, "from", now.Add(-1*time.Hour)),
		parseUnixParam(req, "to", now)
}

// parseUnixParam parses a Unix-epoch seconds query parameter.
func parseUnixParam(req *http.Request, name string, defaultVal time.Time) time.Time {
	s := req.URL.Query().Get(name)
	if s == "" {
		return defaultVal
	}
	ts, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return defaultVal
	}
	return time.Unix(ts, 0)
}

// parseDurationParam parses a duration-in-seconds query parameter.
func parseDurationParam(req *http.Request, name string, defaultVal time.Duration) time.Duration {
	s := req.URL.Query().Get(name)
	if s == "" {
		return defaultVal
	}
	secs, err := strconv.Atoi(s)
	if err != nil {
		return defaultVal
	}
	return time.Duration(secs) * time.Second
}
