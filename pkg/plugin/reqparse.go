package plugin

import (
	"net/http"
	"strconv"
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
func parseEnvironment(req *http.Request) string {
	return queries.MustSanitizeLabel(req.URL.Query().Get("environment"))
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
