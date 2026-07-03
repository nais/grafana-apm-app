// Package fingerprint provides stable exception-identity primitives shared
// across plugin surfaces: in-app stack-frame classification now (#66), the
// versioned fingerprint tiers later (#62).
//
// The frame classification rules are mirrored in TypeScript at
// src/pages/tabs/frontend/frames.ts and both implementations are pinned by the
// shared golden fixtures in testdata/frames.json — change all three together.
package fingerprint

import "strings"

// IsInAppFrame reports whether a stack-frame path points at application code,
// as opposed to SDK internals, vendored dependencies, or runtime plumbing.
//
// Faro's console instrumentation pushes a synthetic Error created inside its
// own handler, so the top frames of console-captured exceptions are always
// Faro internals; grouping or highlighting those frames is pure noise. The
// classifier must tolerate every path shape we see in Loki: webpack:// URLs
// from minified builds, plain source paths after source-map resolution
// (#60), hashed bundle assets, and browser-native frames.
func IsInAppFrame(path string) bool {
	p := strings.TrimSpace(strings.ToLower(path))
	if p == "" || p == "?" {
		return false
	}
	// Browser-native and anonymous frames carry no app location.
	if strings.Contains(p, "[native code]") || strings.Contains(p, "<anonymous>") {
		return false
	}
	// Vendored dependencies, regardless of bundler path prefix
	// (covers node_modules/ and pnpm's node_modules/.pnpm/ layouts).
	if strings.Contains(p, "node_modules/") {
		return false
	}
	// Faro SDK modules. Usually under node_modules/, but source-mapped or
	// vendor-chunked builds can surface bare module paths.
	for _, marker := range []string{"@grafana/faro", "faro-web-sdk", "faro-core", "faro-web-tracing", "faro-react"} {
		if strings.Contains(p, marker) {
			return false
		}
	}
	// Webpack runtime plumbing: after stripping the webpack://<namespace>/
	// scheme prefix, runtime frames live under webpack/ (e.g. webpack/bootstrap,
	// webpack/runtime/...). Application sources keep their own paths.
	if rest, ok := stripWebpackScheme(p); ok && strings.HasPrefix(rest, "webpack/") {
		return false
	}
	return true
}

// stripWebpackScheme removes a leading "webpack://<namespace>/" (or
// "webpack:///") prefix, returning the remaining path and whether the input
// was a webpack URL at all.
func stripWebpackScheme(p string) (string, bool) {
	const scheme = "webpack://"
	if !strings.HasPrefix(p, scheme) {
		return p, false
	}
	rest := p[len(scheme):]
	// webpack:///path (empty namespace) or webpack://ns/path
	if _, after, found := strings.Cut(rest, "/"); found {
		return after, true
	}
	return rest, true
}
