package plugin

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestHandleServicesCacheKeyIncludesStep guards the fix for the services cache
// key omitting the post-clamp step: step sets sparkline resolution, so two
// requests over the same time range with different steps must land on distinct
// cache entries. Before the fix they collided and the second step reused the
// first step's wrong-resolution response.
func TestHandleServicesCacheKeyIncludesStep(t *testing.T) {
	promSrv := mockPromServer(t, nil)
	defer promSrv.Close()
	app := newTestApp(t, promSrv.URL, defaultCaps())

	now := time.Now()
	from := fmt.Sprintf("%d", now.Add(-1*time.Hour).Unix())
	to := fmt.Sprintf("%d", now.Unix())

	do := func(step string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/services?from="+from+"&to="+to+"&step="+step, nil)
		w := httptest.NewRecorder()
		app.handleServices(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("step=%s: expected 200, got %d", step, w.Code)
		}
		return w
	}

	// step=100 and step=300 both exceed the ~72s clamp for a 1h range, so they
	// stay distinct after clamping.

	// First request populates the cache (miss — no X-Cache header).
	if got := do("100").Header().Get("X-Cache"); got == "HIT" {
		t.Fatalf("first request should be a cache miss, got X-Cache=%q", got)
	}
	// Identical range + step → stable key → cache HIT.
	if got := do("100").Header().Get("X-Cache"); got != "HIT" {
		t.Fatalf("identical request should hit cache, got X-Cache=%q", got)
	}
	// Same range, different step → must NOT collide with the step=100 entry.
	if got := do("300").Header().Get("X-Cache"); got == "HIT" {
		t.Fatalf("different step must be a cache miss, got X-Cache=%q", got)
	}
	// And the new step's entry is itself cached on repeat.
	if got := do("300").Header().Get("X-Cache"); got != "HIT" {
		t.Fatalf("repeated step=300 request should hit cache, got X-Cache=%q", got)
	}
}
