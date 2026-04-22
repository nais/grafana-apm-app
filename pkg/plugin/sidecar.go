package plugin

import "strings"

// defaultSidecarNames are infrastructure sidecars injected by the Nais platform.
// These run as containers alongside application containers in the same pod,
// emitting their own OTel spans with a distinct service_name.
var defaultSidecarNames = map[string]bool{
	"wonderwall": true, // Auth proxy (OAuth2/OIDC)
	"texas":      true, // Token exchange sidecar
}

// isSidecar reports whether the given service name is a known infrastructure sidecar.
// Matching is case-insensitive and trims whitespace.
func isSidecar(name string) bool {
	return defaultSidecarNames[strings.TrimSpace(strings.ToLower(name))]
}
