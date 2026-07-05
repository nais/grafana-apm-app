package plugin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

// allowAny is a permissive host predicate for the fetch-logic tests, which run
// against an httptest server whose host is not the production CDN.
func allowAny(string) bool { return true }

func checkByName(t *testing.T, res SourcemapDoctorResult, name string) SourcemapCheck {
	t.Helper()
	for _, c := range res.Checks {
		if c.Name == name {
			return c
		}
	}
	t.Fatalf("no check named %q in %+v", name, res.Checks)
	return SourcemapCheck{}
}

func newSourcemapTestServer() *httptest.Server {
	mux := http.NewServeMux()
	// Bundle that references a published .map — the healthy case.
	mux.HandleFunc("/app.js", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("console.log(1)\n//# sourceMappingURL=app.js.map\n"))
	})
	mux.HandleFunc("/app.js.map", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"version":3}`))
	})
	// Bundle with no sourceMappingURL comment.
	mux.HandleFunc("/nocomment.js", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("console.log(1)\n"))
	})
	// Bundle whose referenced .map is missing.
	mux.HandleFunc("/badmap.js", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("console.log(1)\n//# sourceMappingURL=badmap.js.map\n"))
	})
	mux.HandleFunc("/badmap.js.map", func(w http.ResponseWriter, _ *http.Request) {
		http.NotFound(w, nil)
	})
	// /gone.js is intentionally unregistered → 404.
	return httptest.NewServer(mux)
}

func TestDiagnoseSourcemap_MapPresentPasses(t *testing.T) {
	srv := newSourcemapTestServer()
	defer srv.Close()

	u, _ := url.Parse(srv.URL + "/app.js")
	res := diagnoseSourcemap(context.Background(), srv.Client(), u, allowAny)

	if !res.OK {
		t.Fatalf("expected ok=true, got %+v", res)
	}
	for _, name := range []string{"script-fetchable", "sourcemap-comment", "sourcemap-fetchable"} {
		if c := checkByName(t, res, name); c.Status != "pass" {
			t.Errorf("check %q: want pass, got %q (%s)", name, c.Status, c.Detail)
		}
	}
	if res.SourceMapURL != srv.URL+"/app.js.map" {
		t.Errorf("sourceMapUrl = %q, want %q", res.SourceMapURL, srv.URL+"/app.js.map")
	}
}

func TestDiagnoseSourcemap_ScriptNotFoundFails(t *testing.T) {
	srv := newSourcemapTestServer()
	defer srv.Close()

	u, _ := url.Parse(srv.URL + "/gone.js")
	res := diagnoseSourcemap(context.Background(), srv.Client(), u, allowAny)

	if res.OK {
		t.Fatalf("expected ok=false for a 404 bundle, got %+v", res)
	}
	if c := checkByName(t, res, "script-fetchable"); c.Status != "fail" {
		t.Errorf("script-fetchable: want fail, got %q", c.Status)
	}
}

func TestDiagnoseSourcemap_MissingSourceMappingURLFails(t *testing.T) {
	srv := newSourcemapTestServer()
	defer srv.Close()

	u, _ := url.Parse(srv.URL + "/nocomment.js")
	res := diagnoseSourcemap(context.Background(), srv.Client(), u, allowAny)

	if res.OK {
		t.Fatalf("expected ok=false with no sourceMappingURL, got %+v", res)
	}
	if c := checkByName(t, res, "script-fetchable"); c.Status != "pass" {
		t.Errorf("script-fetchable: want pass, got %q", c.Status)
	}
	if c := checkByName(t, res, "sourcemap-comment"); c.Status != "fail" {
		t.Errorf("sourcemap-comment: want fail, got %q", c.Status)
	}
}

func TestDiagnoseSourcemap_UnfetchableMapFails(t *testing.T) {
	srv := newSourcemapTestServer()
	defer srv.Close()

	u, _ := url.Parse(srv.URL + "/badmap.js")
	res := diagnoseSourcemap(context.Background(), srv.Client(), u, allowAny)

	if res.OK {
		t.Fatalf("expected ok=false when .map is 404, got %+v", res)
	}
	if c := checkByName(t, res, "sourcemap-comment"); c.Status != "pass" {
		t.Errorf("sourcemap-comment: want pass, got %q", c.Status)
	}
	if c := checkByName(t, res, "sourcemap-fetchable"); c.Status != "fail" {
		t.Errorf("sourcemap-fetchable: want fail, got %q", c.Status)
	}
}

func TestSourcemapHostAllowed(t *testing.T) {
	cases := map[string]bool{
		"cdn.nav.no":          true,
		"CDN.NAV.NO":          true,
		"cdn.nav.no:443":      true,
		"evil.example.com":    false,
		"cdn.nav.no.evil.com": false,
		"localhost:8080":      false,
		"cdn.nav.no.":         false, // trailing-dot FQDN is not the exact host
		"internal.nais.local": false,
	}
	for host, want := range cases {
		if got := sourcemapHostAllowed(host); got != want {
			t.Errorf("sourcemapHostAllowed(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestHandleSourcemapDoctor_RejectsNonCDNHost(t *testing.T) {
	app := &App{healthClient: &http.Client{Timeout: 5 * time.Second}}

	req := httptest.NewRequest(http.MethodGet, "/services/ns/svc/sourcemap-doctor?url=http://evil.example.com/app.js", nil)
	req.SetPathValue("namespace", "ns")
	req.SetPathValue("service", "svc")
	rec := httptest.NewRecorder()

	app.handleSourcemapDoctor(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (off-CDN host must be rejected before any fetch)", rec.Code)
	}
}

func TestHandleSourcemapDoctor_RejectsMissingURL(t *testing.T) {
	app := &App{healthClient: &http.Client{Timeout: 5 * time.Second}}

	req := httptest.NewRequest(http.MethodGet, "/services/ns/svc/sourcemap-doctor", nil)
	req.SetPathValue("namespace", "ns")
	req.SetPathValue("service", "svc")
	rec := httptest.NewRecorder()

	app.handleSourcemapDoctor(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for missing url", rec.Code)
	}
}
