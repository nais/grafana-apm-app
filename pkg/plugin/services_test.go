package plugin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

func TestHandleServicesDiscoversActivityAcrossSelectedRange(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	promSrv, captured := queryCapturingPromServer(t, map[string][]queries.PromResult{
		"present_over_time(traces_spanmetrics_calls_total": {
			{
				Metric: map[string]string{
					"service_name":           "ida",
					"service_namespace":      "traktor",
					"telemetry_sdk_language": "java",
					"k8s_cluster_name":       "prod",
				},
				Value: queries.NewPromValue(float64(now.Unix()), "1"),
			},
		},
	})
	defer promSrv.Close()

	app := newTestApp(t, promSrv.URL, defaultCaps())
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf(
		"/services?from=%d&to=%d", now.Add(-time.Hour).Unix(), now.Unix(),
	), nil)
	w := httptest.NewRecorder()
	app.handleServices(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var services []queries.ServiceSummary
	if err := json.Unmarshal(w.Body.Bytes(), &services); err != nil {
		t.Fatal(err)
	}
	if len(services) != 1 || services[0].Name != "ida" || services[0].SDKLanguage != "java" {
		t.Fatalf("expected historical ida service with Java SDK, got %+v", services)
	}

	var discovered, historicalRate, sparkline bool
	for _, query := range *captured {
		if strings.Contains(query, "present_over_time(traces_spanmetrics_calls_total") &&
			strings.Contains(query, "[1h]") {
			discovered = true
		}
		if strings.Contains(query, `span_kind="SPAN_KIND_SERVER"`) &&
			strings.Contains(query, "rate(traces_spanmetrics_calls_total") {
			if strings.Contains(query, "[1h]") {
				historicalRate = true
			}
			if strings.Contains(query, "[5m]") {
				sparkline = true
			}
		}
	}
	if !discovered || !historicalRate || !sparkline {
		t.Errorf("expected 1h discovery and RED rate with 5m sparklines; queries: %v", *captured)
	}
}

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

func TestHandleServicesCacheKeyIncludesQueryWindow(t *testing.T) {
	promSrv := mockPromServer(t, nil)
	defer promSrv.Close()
	app := newTestApp(t, promSrv.URL, defaultCaps())

	base := time.Now().Add(-time.Hour).Unix() / 30 * 30
	request := func(from, to int64) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, fmt.Sprintf(
			"/services?from=%d&to=%d&withSeries=false", from, to,
		), nil)
		w := httptest.NewRecorder()
		app.handleServices(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		return w
	}

	// Both timestamp pairs round to the same 30-second cache buckets, but
	// their PromQL lookbacks round to 30m and 31m respectively.
	if got := request(base+29, base+1830).Header().Get("X-Cache"); got == "HIT" {
		t.Fatal("first 30m request should miss the cache")
	}
	if got := request(base+29, base+1830).Header().Get("X-Cache"); got != "HIT" {
		t.Fatal("repeated 30m request should hit the cache")
	}
	if got := request(base, base+1859).Header().Get("X-Cache"); got == "HIT" {
		t.Fatal("31m request should not reuse the 30m response")
	}
	if got := request(base, base+1859).Header().Get("X-Cache"); got != "HIT" {
		t.Fatal("repeated 31m request should hit the cache")
	}
}
