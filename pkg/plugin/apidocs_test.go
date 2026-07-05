package plugin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// openAPISpecPath is the hand-maintained OpenAPI document that must stay in sync
// with the routes registered in app.go.
const openAPISpecPath = "../../docs/api/openapi.yaml"

// internalRouteAllowlist lists routes that are intentionally NOT documented in
// openapi.yaml because they are internal helpers, not part of the public API
// surface. Keep this list tiny and justify every entry.
var internalRouteAllowlist = map[string]string{
	"/ping": "internal health/liveness probe, not a public API endpoint",
}

// TestEveryRouteIsDocumented walks the resource routes registered by the app and
// fails if any route is missing from docs/api/openapi.yaml. This keeps the API
// reference honest: adding a route without documenting it (and without an
// explicit allowlist entry) breaks the build.
func TestEveryRouteIsDocumented(t *testing.T) {
	documented, err := openAPIPaths(openAPISpecPath)
	if err != nil {
		t.Fatalf("reading OpenAPI paths: %v", err)
	}
	if len(documented) == 0 {
		t.Fatalf("no paths parsed from %s — parser or file is broken", openAPISpecPath)
	}

	var app App
	for _, r := range app.routes() {
		if reason, ok := internalRouteAllowlist[r.pattern]; ok {
			t.Logf("route %s is allowlisted (undocumented): %s", r.pattern, reason)
			continue
		}
		if !documented[r.pattern] {
			t.Errorf("route %q is registered in app.go but missing from %s "+
				"(document it, or add it to internalRouteAllowlist with a reason)",
				r.pattern, openAPISpecPath)
		}
	}
}

// TestOpenAPIHasNoStalePaths fails if openapi.yaml documents a path that is no
// longer registered — the reverse-drift guard.
func TestOpenAPIHasNoStalePaths(t *testing.T) {
	documented, err := openAPIPaths(openAPISpecPath)
	if err != nil {
		t.Fatalf("reading OpenAPI paths: %v", err)
	}

	registered := make(map[string]bool)
	var app App
	for _, r := range app.routes() {
		registered[r.pattern] = true
	}

	for p := range documented {
		if !registered[p] {
			t.Errorf("path %q is documented in %s but not registered in app.go", p, openAPISpecPath)
		}
	}
}

// openAPIPaths extracts the top-level keys of the `paths:` map from an OpenAPI
// YAML document without pulling in a YAML dependency. It relies on the document
// being conventionally indented: `paths:` at column 0, each path key indented by
// exactly two spaces and ending in a colon, terminating at the next column-0 key.
func openAPIPaths(path string) (map[string]bool, error) {
	data, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return nil, err
	}

	paths := make(map[string]bool)
	inPaths := false
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "#") {
			continue
		}
		// A non-indented, non-empty line starts a new top-level section.
		if len(line) > 0 && line[0] != ' ' && line[0] != '\t' {
			inPaths = strings.HasPrefix(line, "paths:")
			continue
		}
		if !inPaths {
			continue
		}
		// Path keys are indented exactly two spaces: "  /foo/{bar}:".
		if !strings.HasPrefix(line, "  /") {
			continue
		}
		if strings.HasPrefix(line, "   ") { // deeper than 2 spaces => not a path key
			continue
		}
		trimmed := strings.TrimSpace(line)
		if !strings.HasSuffix(trimmed, ":") {
			continue
		}
		key := strings.TrimSuffix(trimmed, ":")
		if strings.HasPrefix(key, "/") {
			paths[key] = true
		}
	}
	return paths, nil
}
