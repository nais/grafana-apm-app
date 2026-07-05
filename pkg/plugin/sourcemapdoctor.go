package plugin

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// Source-map doctor (#60).
//
// Frontend-stack deobfuscation happens server-side at ingest: Alloy's
// faro.receiver resolves the `.map` and writes the resolved stack to Loki. When
// a stored stack is still minified, the resolution didn't happen — this handler
// helps explain *why* by probing the offending bundle. It is pure diagnostics:
// it NEVER resolves or symbolicates a stack itself (an explicit non-goal), and
// the actual ingest fix is a cross-repo Alloy config change owned by the
// platform team.
//
// SSRF guard: this is the one handler that makes an outbound request to a
// URL supplied by the caller, so the target host is allowlisted to cdn.nav.no
// (the public frontend-asset CDN). The initial URL, the resolved `.map` URL,
// and every redirect hop are all validated against the allowlist before a
// request is issued.

// sourcemapCDNHost is the only host the doctor will fetch from.
const sourcemapCDNHost = "cdn.nav.no"

// maxSourcemapBytes caps how much of a bundle/map we read. Bundles are large,
// but the sourceMappingURL comment lives near the end; we read up to this cap
// and scan for it.
const maxSourcemapBytes = 24 << 20 // 24 MiB

// sourceMappingRe matches a `//# sourceMappingURL=<ref>` (or the legacy `//@`)
// annotation. The reference may be a relative path, an absolute URL, or an
// inline `data:` URI.
var sourceMappingRe = regexp.MustCompile(`//[#@]\s*sourceMappingURL=(\S+)`)

// SourcemapCheck is one pass/fail step in the diagnosis.
type SourcemapCheck struct {
	Name   string `json:"name"`
	Status string `json:"status"` // "pass" | "fail" | "skip"
	Detail string `json:"detail,omitempty"`
}

// SourcemapDoctorResult is the /sourcemap-doctor payload.
type SourcemapDoctorResult struct {
	URL          string           `json:"url"`
	OK           bool             `json:"ok"`
	Checks       []SourcemapCheck `json:"checks"`
	SourceMapURL string           `json:"sourceMapUrl,omitempty"`
}

// sourcemapHostAllowed reports whether host (optionally with a port) is the
// allowlisted frontend-asset CDN. Case-insensitive; the bare port is ignored.
func sourcemapHostAllowed(host string) bool {
	h := strings.ToLower(host)
	if i := strings.IndexByte(h, ':'); i >= 0 {
		h = h[:i]
	}
	return h == sourcemapCDNHost
}

// handleSourcemapDoctor probes a minified frame's bundle and returns a pass/fail
// checklist explaining whether its source map is resolvable.
// GET /services/{namespace}/{service}/sourcemap-doctor?url=<frameJsUrl>
func (a *App) handleSourcemapDoctor(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	_, service := parseServiceRef(req)
	if !requireServiceParam(w, service) {
		return
	}

	raw := strings.TrimSpace(req.URL.Query().Get("url"))
	if raw == "" {
		http.Error(w, `{"error":"missing url query parameter"}`, http.StatusBadRequest)
		return
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || !sourcemapHostAllowed(u.Host) {
		// SSRF guard: only absolute http(s) URLs on the allowlisted CDN.
		http.Error(w, fmt.Sprintf(`{"error":"url must be an absolute http(s) URL on %s"}`, sourcemapCDNHost), http.StatusBadRequest)
		return
	}

	// Reuse the shared outbound client's transport/timeout, but add a
	// redirect guard so a 30x can't bounce the request off the allowlist.
	client := &http.Client{
		Timeout:   a.healthClient.Timeout,
		Transport: a.healthClient.Transport,
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if !sourcemapHostAllowed(r.URL.Host) {
				return fmt.Errorf("redirect to disallowed host %q blocked", r.URL.Host)
			}
			if len(via) >= 5 {
				return fmt.Errorf("stopped after 5 redirects")
			}
			return nil
		},
	}

	res := diagnoseSourcemap(req.Context(), client, u, sourcemapHostAllowed)
	writeJSON(w, res)
}

// diagnoseSourcemap runs the pass/fail checklist against a bundle URL. It is
// split from the handler so tests can drive it against an httptest server: the
// handler enforces the host allowlist up front, and allowHost re-validates the
// resolved `.map` URL host here (a relative map resolves to the same allowlisted
// host; an absolute cross-host map is refused rather than fetched).
func diagnoseSourcemap(ctx context.Context, client *http.Client, jsURL *url.URL, allowHost func(string) bool) SourcemapDoctorResult {
	res := SourcemapDoctorResult{URL: jsURL.String()}

	// Check 1: the bundle itself is fetchable.
	body, status, err := fetchLimited(ctx, client, jsURL.String(), maxSourcemapBytes)
	if err != nil {
		res.Checks = append(res.Checks, SourcemapCheck{Name: "script-fetchable", Status: "fail", Detail: "could not fetch bundle: " + err.Error()})
		return res
	}
	if status != http.StatusOK {
		res.Checks = append(res.Checks, SourcemapCheck{Name: "script-fetchable", Status: "fail", Detail: fmt.Sprintf("bundle returned HTTP %d", status)})
		return res
	}
	res.Checks = append(res.Checks, SourcemapCheck{Name: "script-fetchable", Status: "pass", Detail: "HTTP 200"})

	// Check 2: the bundle advertises a source map.
	ref := extractSourceMappingURL(body)
	if ref == "" {
		res.Checks = append(res.Checks, SourcemapCheck{Name: "sourcemap-comment", Status: "fail", Detail: "no //# sourceMappingURL= comment — the build did not emit a source-map reference"})
		return res
	}

	// An inline data: URI carries the whole map; nothing to fetch.
	if strings.HasPrefix(ref, "data:") {
		res.SourceMapURL = "(inline data URI)"
		res.Checks = append(res.Checks, SourcemapCheck{Name: "sourcemap-comment", Status: "pass", Detail: "inline source map (data URI)"})
		res.Checks = append(res.Checks, SourcemapCheck{Name: "sourcemap-fetchable", Status: "pass", Detail: "inline — no separate fetch needed"})
		res.OK = true
		return res
	}
	res.Checks = append(res.Checks, SourcemapCheck{Name: "sourcemap-comment", Status: "pass", Detail: "references " + ref})

	// Check 3: the referenced .map is fetchable.
	mapURL, err := jsURL.Parse(ref)
	if err != nil {
		res.Checks = append(res.Checks, SourcemapCheck{Name: "sourcemap-fetchable", Status: "fail", Detail: "unparseable sourceMappingURL: " + err.Error()})
		return res
	}
	res.SourceMapURL = mapURL.String()
	if !allowHost(mapURL.Host) {
		res.Checks = append(res.Checks, SourcemapCheck{Name: "sourcemap-fetchable", Status: "fail", Detail: "source map points off-CDN (" + mapURL.Host + ") — not fetched"})
		return res
	}
	_, mapStatus, err := fetchLimited(ctx, client, mapURL.String(), maxSourcemapBytes)
	if err != nil {
		res.Checks = append(res.Checks, SourcemapCheck{Name: "sourcemap-fetchable", Status: "fail", Detail: "could not fetch .map: " + err.Error()})
		return res
	}
	if mapStatus != http.StatusOK {
		res.Checks = append(res.Checks, SourcemapCheck{Name: "sourcemap-fetchable", Status: "fail", Detail: fmt.Sprintf(".map returned HTTP %d — it isn't published alongside the bundle", mapStatus)})
		return res
	}
	res.Checks = append(res.Checks, SourcemapCheck{Name: "sourcemap-fetchable", Status: "pass", Detail: "HTTP 200"})
	res.OK = true
	return res
}

// extractSourceMappingURL returns the reference from the last sourceMappingURL
// annotation in body (the meaningful one is emitted at the end of a bundle), or
// "" if none is present.
func extractSourceMappingURL(body []byte) string {
	matches := sourceMappingRe.FindAllSubmatch(body, -1)
	if len(matches) == 0 {
		return ""
	}
	return string(matches[len(matches)-1][1])
}

// fetchLimited GETs rawURL and returns up to limit bytes of the body plus the
// HTTP status. The body is always capped to bound memory on large bundles.
func fetchLimited(ctx context.Context, client *http.Client, rawURL string, limit int64) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close() //nolint:errcheck
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}
