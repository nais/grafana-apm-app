package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/fingerprint"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// occLine is one mocked Loki log entry with its per-row label map, served as a
// dataplane log frame (labels/timestamp/body columns).
type occLine struct {
	TimeMs int64
	Line   string
	Labels map[string]string
}

// occTestApp stands up a /api/ds/query mock that answers range (log) queries
// from logs keyed by expr substring, emitting a dataplane frame with a per-row
// `labels` column so LogQueryWithLabels can recover structured metadata.
func occTestApp(t *testing.T, logs map[string][]occLine) (*App, *queries.DsQueryClient) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Queries []struct {
				RefID string `json:"refId"`
				Expr  string `json:"expr"`
			} `json:"queries"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Queries) == 0 {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		expr := req.Queries[0].Expr
		type frame struct {
			Schema struct {
				Fields []map[string]any `json:"fields"`
			} `json:"schema"`
			Data struct {
				Values []any `json:"values"`
			} `json:"data"`
		}
		type result struct {
			Frames []frame `json:"frames"`
		}
		res := result{}
		for key, lines := range logs {
			if !strings.Contains(expr, key) {
				continue
			}
			labelsCol := make([]map[string]string, len(lines))
			times := make([]int64, len(lines))
			bodies := make([]string, len(lines))
			for i, l := range lines {
				labelsCol[i] = l.Labels
				times[i] = l.TimeMs
				bodies[i] = l.Line
			}
			var f frame
			f.Schema.Fields = []map[string]any{{"name": "labels"}, {"name": "timestamp"}, {"name": "body"}}
			f.Data.Values = []any{labelsCol, times, bodies}
			res.Frames = append(res.Frames, f)
			break
		}
		writeMock(w, map[string]any{"results": map[string]any{req.Queries[0].RefID: res}})
	}))
	t.Cleanup(srv.Close)
	app := &App{otelCfg: otelconfig.Default()}
	ds := queries.NewDsQueryClient(srv.URL, "")
	return app, ds
}

// exprKeys mirror the three occurrence pipelines built by queryIssueOccurrences.
const (
	keySemconv = `exception_type != ""`
	keyJSON    = `| json | level=~`
	keyPlain   = `drop __error__`
)

func TestQueryIssueOccurrencesSemconvShape(t *testing.T) {
	wantFP := fingerprint.Compute(fingerprint.Event{Type: "NullPointerException", Value: "value is null"}).Value

	app, ds := occTestApp(t, map[string][]occLine{
		keySemconv: {
			{TimeMs: 2000, Labels: map[string]string{
				"exception_type": "NullPointerException", "exception_message": "value is null",
				"exception_stacktrace": "at Foo.bar(Foo.java:10)", "k8s_pod_name": "app-a",
				"detected_level": "error", "service_version": "1.2.3",
				// Trace correlation + extra structured-metadata context.
				"trace_id": "abc123def456", "span_id": "span-9",
				"k8s_container_name": "main", "logger": "com.example.Foo",
				// Internal Loki label — must never leak into Attributes.
				"__error__": "somefailure",
			}},
			{TimeMs: 3000, Labels: map[string]string{
				"exception_type": "NullPointerException", "exception_message": "value is null",
				"exception_stacktrace": "at Foo.bar(Foo.java:10)", "k8s_pod_name": "app-b",
				"detected_level": "error",
			}},
			// Different fingerprint — must be filtered out.
			{TimeMs: 4000, Labels: map[string]string{
				"exception_type": "TimeoutException", "exception_message": "deadline exceeded",
				"k8s_pod_name": "app-a",
			}},
		},
	})

	resp := app.queryIssueOccurrences(context.Background(), ds, "loki", "my-app", "", wantFP, time.Unix(0, 0), time.Unix(3600, 0))

	if resp.Shape != "otlp" {
		t.Errorf("shape = %q, want otlp", resp.Shape)
	}
	if len(resp.Occurrences) != 2 {
		t.Fatalf("got %d occurrences, want 2 (fingerprint-filtered): %+v", len(resp.Occurrences), resp.Occurrences)
	}
	// Newest first.
	if resp.Occurrences[0].TimeMs != 3000 {
		t.Errorf("occurrences not sorted newest-first: %+v", resp.Occurrences)
	}
	o := resp.Occurrences[1]
	if o.Type != "NullPointerException" || o.Message != "value is null" {
		t.Errorf("type/message = %q/%q", o.Type, o.Message)
	}
	if o.Stacktrace != "at Foo.bar(Foo.java:10)" {
		t.Errorf("stacktrace = %q", o.Stacktrace)
	}
	if o.Pod != "app-a" || o.Level != "error" || o.Version != "1.2.3" {
		t.Errorf("pod/level/version = %q/%q/%q", o.Pod, o.Level, o.Version)
	}
	if o.TraceID != "abc123def456" || o.SpanID != "span-9" {
		t.Errorf("trace/span = %q/%q, want abc123def456/span-9", o.TraceID, o.SpanID)
	}
	// Attributes carry the extra structured-metadata context, minus everything
	// already modeled (pod/level/type/message/stacktrace/version/trace_id) and
	// Loki's internal __*__ labels.
	if o.Attributes["k8s_container_name"] != "main" || o.Attributes["logger"] != "com.example.Foo" {
		t.Errorf("attributes missing extra context: %+v", o.Attributes)
	}
	for _, banned := range []string{"k8s_pod_name", "detected_level", "exception_type", "exception_message", "exception_stacktrace", "service_version", "trace_id", "span_id", "__error__"} {
		if _, ok := o.Attributes[banned]; ok {
			t.Errorf("attributes must not include modeled/internal key %q: %+v", banned, o.Attributes)
		}
	}
	if resp.Stats.Total != 2 || resp.Stats.Pods != 2 {
		t.Errorf("stats = %+v, want total=2 pods=2", resp.Stats)
	}
	if resp.Stats.FirstSeenMs != 2000 || resp.Stats.LastSeenMs != 3000 {
		t.Errorf("first/last seen = %d/%d", resp.Stats.FirstSeenMs, resp.Stats.LastSeenMs)
	}
	if len(resp.Stats.Versions) != 1 || resp.Stats.Versions[0] != "1.2.3" {
		t.Errorf("versions = %v", resp.Stats.Versions)
	}
}

func TestQueryIssueOccurrencesJSONShape(t *testing.T) {
	// Message-only fingerprint (no type) — matches how shape (b) is grouped.
	wantFP := fingerprint.Compute(fingerprint.Event{Value: "db connection failed"}).Value

	app, ds := occTestApp(t, map[string][]occLine{
		keyJSON: {
			{TimeMs: 5000, Line: `{"level":"error","message":"db connection failed","stack_trace":"goroutine 1..."}`,
				Labels: map[string]string{"k8s_pod_name": "svc-1", "detected_level": "error"}},
			// slog-style msg field, same logical message → same fingerprint.
			{TimeMs: 6000, Line: `{"level":"ERROR","msg":"db connection failed"}`,
				Labels: map[string]string{"k8s_pod_name": "svc-2"}},
			// Different message → filtered out.
			{TimeMs: 7000, Line: `{"level":"error","message":"cache miss"}`,
				Labels: map[string]string{"k8s_pod_name": "svc-1"}},
		},
	})

	resp := app.queryIssueOccurrences(context.Background(), ds, "loki", "my-app", "", wantFP, time.Unix(0, 0), time.Unix(3600, 0))

	if resp.Shape != "json" {
		t.Errorf("shape = %q, want json", resp.Shape)
	}
	if len(resp.Occurrences) != 2 {
		t.Fatalf("got %d occurrences, want 2: %+v", len(resp.Occurrences), resp.Occurrences)
	}
	// Find the one with a stack trace.
	var withStack *IssueOccurrence
	for i := range resp.Occurrences {
		if resp.Occurrences[i].Stacktrace != "" {
			withStack = &resp.Occurrences[i]
		}
	}
	if withStack == nil || withStack.Stacktrace != "goroutine 1..." {
		t.Errorf("expected a parsed stack_trace, got %+v", resp.Occurrences)
	}
	if withStack.Message != "db connection failed" || withStack.Level != "error" || withStack.Pod != "svc-1" {
		t.Errorf("json extraction wrong: %+v", withStack)
	}
	if resp.Stats.Pods != 2 {
		t.Errorf("pods = %d, want 2", resp.Stats.Pods)
	}
}

// TestQueryIssueOccurrencesJSONTraceAndAttributes covers the richer-context
// path for thin shape (b) lines: trace_id read from the JSON body (no structured
// metadata), plus app-added scalar fields surfaced as Attributes while modeled
// body fields (message/level/stack_trace) are excluded.
func TestQueryIssueOccurrencesJSONTraceAndAttributes(t *testing.T) {
	wantFP := fingerprint.Compute(fingerprint.Event{Value: "Failed to fetch decorator"}).Value

	app, ds := occTestApp(t, map[string][]occLine{
		keyJSON: {
			{TimeMs: 5000, Line: `{"level":"warn","message":"Failed to fetch decorator","traceId":"body-trace-1","http_route":"/api/decorator","http_status":502,"logger":"decorator"}`,
				Labels: map[string]string{"k8s_pod_name": "svc-1", "detected_level": "warn", "k8s_node_name": "node-7"}},
		},
	})

	resp := app.queryIssueOccurrences(context.Background(), ds, "loki", "my-app", "", wantFP, time.Unix(0, 0), time.Unix(3600, 0))

	if len(resp.Occurrences) != 1 {
		t.Fatalf("got %d occurrences, want 1: %+v", len(resp.Occurrences), resp.Occurrences)
	}
	o := resp.Occurrences[0]
	if o.TraceID != "body-trace-1" {
		t.Errorf("traceId = %q, want body-trace-1 (from JSON body)", o.TraceID)
	}
	// Structured metadata + scalar body fields both surface as attributes.
	if o.Attributes["k8s_node_name"] != "node-7" {
		t.Errorf("attributes missing structured-metadata field: %+v", o.Attributes)
	}
	if o.Attributes["http_route"] != "/api/decorator" || o.Attributes["http_status"] != "502" || o.Attributes["logger"] != "decorator" {
		t.Errorf("attributes missing app-added body fields: %+v", o.Attributes)
	}
	for _, banned := range []string{"message", "level", "traceId"} {
		if _, ok := o.Attributes[banned]; ok {
			t.Errorf("attributes must not include modeled body key %q: %+v", banned, o.Attributes)
		}
	}
}

func TestQueryIssueOccurrencesPlainShapeFiltersNoise(t *testing.T) {
	wantFP := fingerprint.Compute(fingerprint.Event{Value: "panic: runtime error"}).Value

	app, ds := occTestApp(t, map[string][]occLine{
		keyPlain: {
			{TimeMs: 8000, Line: "panic: runtime error", Labels: map[string]string{"k8s_pod_name": "p1", "detected_level": "error", "trace_id": "plain-trace-1"}},
			// logback bootstrap noise — must be dropped even before fingerprinting.
			{TimeMs: 8500, Line: "12:00:00,000 |-INFO in ch.qos.logback.classic.LoggerContext - hello", Labels: map[string]string{"k8s_pod_name": "p1"}},
			// Different message.
			{TimeMs: 9000, Line: "some other error", Labels: map[string]string{"k8s_pod_name": "p2"}},
		},
	})

	resp := app.queryIssueOccurrences(context.Background(), ds, "loki", "my-app", "", wantFP, time.Unix(0, 0), time.Unix(3600, 0))

	if resp.Shape != "plaintext" {
		t.Errorf("shape = %q, want plaintext", resp.Shape)
	}
	if len(resp.Occurrences) != 1 {
		t.Fatalf("got %d occurrences, want 1 (noise + non-match filtered): %+v", len(resp.Occurrences), resp.Occurrences)
	}
	o := resp.Occurrences[0]
	if o.Message != "panic: runtime error" || o.Pod != "p1" || o.Level != "error" {
		t.Errorf("plain extraction wrong: %+v", o)
	}
	if o.TraceID != "plain-trace-1" {
		t.Errorf("traceId = %q, want plain-trace-1 (best-effort from labels)", o.TraceID)
	}
	if o.Stacktrace != "" {
		t.Errorf("plain occurrence should have no stacktrace, got %q", o.Stacktrace)
	}
}

func TestQueryIssueOccurrencesNoMatchIsEmpty(t *testing.T) {
	app, ds := occTestApp(t, map[string][]occLine{
		keySemconv: {
			{TimeMs: 1000, Labels: map[string]string{"exception_type": "Foo", "exception_message": "bar"}},
		},
	})
	resp := app.queryIssueOccurrences(context.Background(), ds, "loki", "my-app", "", "v1:doesnotexist", time.Unix(0, 0), time.Unix(3600, 0))
	if len(resp.Occurrences) != 0 {
		t.Errorf("want no occurrences, got %+v", resp.Occurrences)
	}
	if resp.Shape != "" {
		t.Errorf("shape = %q, want empty when nothing matched", resp.Shape)
	}
	if resp.Stats.Total != 0 {
		t.Errorf("stats.total = %d, want 0", resp.Stats.Total)
	}
	// Versions is always a non-nil slice so the JSON payload is [] not null.
	if resp.Stats.Versions == nil {
		t.Error("stats.versions should be non-nil")
	}
}

// TestHandleIssueOccurrencesUnavailableSerializesEmptyVersions guards the
// OpenAPI contract: when Loki is unconfigured the handler still emits
// stats.versions as [] (a non-nil array), never null.
func TestHandleIssueOccurrencesUnavailableSerializesEmptyVersions(t *testing.T) {
	// Empty settings → LogsDataSource resolves to an empty UID → unavailable.
	app := &App{otelCfg: otelconfig.Default(), settings: queries.PluginSettings{}}
	mux := http.NewServeMux()
	app.registerRoutes(mux)

	req := httptest.NewRequest(http.MethodGet,
		"/services/myns/mysvc/issues/occurrences?fingerprint=v1:abc&from=0&to=3600", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"versions":[]`) {
		t.Errorf("body must serialize versions as [], got: %s", body)
	}
	if strings.Contains(body, `"versions":null`) {
		t.Errorf("versions serialized as null (schema violation): %s", body)
	}

	var resp IssueOccurrencesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !resp.Unavailable {
		t.Error("expected unavailable=true")
	}
	if resp.Stats.Versions == nil {
		t.Error("stats.versions must be a non-nil slice")
	}
	if resp.Occurrences == nil {
		t.Error("occurrences must be a non-nil slice")
	}
}
