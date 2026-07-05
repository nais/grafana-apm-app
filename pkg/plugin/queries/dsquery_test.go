package queries

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// dsTestClient stands up an httptest server that returns a fixed /api/ds/query
// response body, and returns a client pointed at it. This exercises the whole
// execute + frame-flatten path (unmarshal, refId selection, field/value
// alignment) against hand-crafted frame edges.
func dsTestClient(t *testing.T, status int, body string) *DsQueryClient {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return NewDsQueryClient(srv.URL, "test-token")
}

func TestInstantQueryFrameParsing(t *testing.T) {
	at := time.Unix(1000, 0)

	t.Run("multiple series flatten with last value and labels", func(t *testing.T) {
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[
				{"name":"Time"},
				{"name":"Value","labels":{"hash":"111"}},
				{"name":"Value","labels":{"hash":"222"}}
			]},
			"data":{"values":[[1000,2000],[3,4],[5,6]]}
		}]}}}`
		res, err := dsTestClient(t, http.StatusOK, body).InstantQuery(context.Background(), "loki", "expr", at)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(res) != 2 {
			t.Fatalf("got %d results, want 2: %+v", len(res), res)
		}
		if res[0].Metric["hash"] != "111" || res[0].Value.Float() != 4 {
			t.Errorf("res[0] = %+v, want hash=111 value=4 (last)", res[0])
		}
		if res[1].Metric["hash"] != "222" || res[1].Value.Float() != 6 {
			t.Errorf("res[1] = %+v, want hash=222 value=6 (last)", res[1])
		}
	})

	t.Run("single-field frame (missing value field) is skipped", func(t *testing.T) {
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[{"name":"Time"}]},
			"data":{"values":[[1000]]}
		}]}}}`
		res, err := dsTestClient(t, http.StatusOK, body).InstantQuery(context.Background(), "loki", "expr", at)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(res) != 0 {
			t.Errorf("got %d results, want 0: %+v", len(res), res)
		}
	})

	t.Run("malformed value array skips only that series", func(t *testing.T) {
		// Second value column is strings, not numbers → unmarshal to []float64
		// fails and that series drops; the well-formed one survives.
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[
				{"name":"Time"},
				{"name":"V","labels":{"a":"1"}},
				{"name":"V","labels":{"a":"2"}}
			]},
			"data":{"values":[[1000],["nope"],[9]]}
		}]}}}`
		res, err := dsTestClient(t, http.StatusOK, body).InstantQuery(context.Background(), "loki", "expr", at)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(res) != 1 || res[0].Metric["a"] != "2" || res[0].Value.Float() != 9 {
			t.Errorf("got %+v, want single a=2 value=9", res)
		}
	})

	t.Run("empty value array skips series", func(t *testing.T) {
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[{"name":"Time"},{"name":"V"}]},
			"data":{"values":[[1000],[]]}
		}]}}}`
		res, err := dsTestClient(t, http.StatusOK, body).InstantQuery(context.Background(), "loki", "expr", at)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(res) != 0 {
			t.Errorf("got %d results, want 0", len(res))
		}
	})

	t.Run("nil labels yield a nil metric map, not a panic", func(t *testing.T) {
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[{"name":"Time"},{"name":"V"}]},
			"data":{"values":[[1000],[7]]}
		}]}}}`
		res, err := dsTestClient(t, http.StatusOK, body).InstantQuery(context.Background(), "loki", "expr", at)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(res) != 1 || res[0].Value.Float() != 7 {
			t.Fatalf("got %+v, want single value=7", res)
		}
		if res[0].Metric != nil {
			t.Errorf("metric = %+v, want nil (labels absent)", res[0].Metric)
		}
		// Reading a missing label off a nil map is defined (zero value).
		if res[0].Metric["missing"] != "" {
			t.Errorf("nil-map lookup = %q, want empty", res[0].Metric["missing"])
		}
	})

	t.Run("missing refId A is an error", func(t *testing.T) {
		body := `{"results":{"B":{"frames":[]}}}`
		_, err := dsTestClient(t, http.StatusOK, body).InstantQuery(context.Background(), "loki", "expr", at)
		if err == nil {
			t.Fatal("expected error for missing refId A")
		}
	})

	t.Run("multiple refIds select A and ignore the rest", func(t *testing.T) {
		body := `{"results":{
			"A":{"frames":[{"schema":{"fields":[{"name":"Time"},{"name":"V","labels":{"who":"a"}}]},"data":{"values":[[1000],[1]]}}]},
			"B":{"frames":[{"schema":{"fields":[{"name":"Time"},{"name":"V","labels":{"who":"b"}}]},"data":{"values":[[1000],[2]]}}]}
		}}`
		res, err := dsTestClient(t, http.StatusOK, body).InstantQuery(context.Background(), "loki", "expr", at)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(res) != 1 || res[0].Metric["who"] != "a" {
			t.Errorf("got %+v, want only refId A's series (who=a)", res)
		}
	})

	t.Run("per-result error propagates", func(t *testing.T) {
		body := `{"results":{"A":{"error":"parse error at line 1"}}}`
		_, err := dsTestClient(t, http.StatusOK, body).InstantQuery(context.Background(), "loki", "expr", at)
		if err == nil {
			t.Fatal("expected error from result.Error")
		}
	})

	t.Run("non-200 status is an error", func(t *testing.T) {
		_, err := dsTestClient(t, http.StatusBadGateway, "upstream boom").InstantQuery(context.Background(), "loki", "expr", at)
		if err == nil {
			t.Fatal("expected error on non-200 status")
		}
	})
}

func TestLogQueryFrameParsing(t *testing.T) {
	from, to := time.Unix(0, 0), time.Unix(3600, 0)

	t.Run("legacy Time/Line field names", func(t *testing.T) {
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[{"name":"Time"},{"name":"Line"}]},
			"data":{"values":[[1000,2000],["a","b"]]}
		}]}}}`
		out, err := dsTestClient(t, http.StatusOK, body).LogQuery(context.Background(), "loki", "expr", from, to, 100)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(out) != 2 || out[0].Line != "a" || out[0].TimeMs != 1000 || out[1].Line != "b" {
			t.Errorf("got %+v, want [{1000 a} {2000 b}]", out)
		}
	})

	t.Run("dataplane timestamp/body field names", func(t *testing.T) {
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[{"name":"timestamp"},{"name":"body"}]},
			"data":{"values":[[5000],["hello"]]}
		}]}}}`
		out, err := dsTestClient(t, http.StatusOK, body).LogQuery(context.Background(), "loki", "expr", from, to, 100)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(out) != 1 || out[0].Line != "hello" || out[0].TimeMs != 5000 {
			t.Errorf("got %+v, want [{5000 hello}]", out)
		}
	})

	t.Run("mismatched parallel array lengths cap at the shorter", func(t *testing.T) {
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[{"name":"Time"},{"name":"Line"}]},
			"data":{"values":[[1,2,3],["a","b"]]}
		}]}}}`
		out, err := dsTestClient(t, http.StatusOK, body).LogQuery(context.Background(), "loki", "expr", from, to, 100)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(out) != 2 {
			t.Fatalf("got %d entries, want 2 (min of 3 times, 2 lines): %+v", len(out), out)
		}
		if out[1].Line != "b" {
			t.Errorf("out[1].Line = %q, want b", out[1].Line)
		}
	})

	t.Run("missing line field skips the frame", func(t *testing.T) {
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[{"name":"Time"}]},
			"data":{"values":[[1000]]}
		}]}}}`
		out, err := dsTestClient(t, http.StatusOK, body).LogQuery(context.Background(), "loki", "expr", from, to, 100)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(out) != 0 {
			t.Errorf("got %d entries, want 0 (no line column)", len(out))
		}
	})

	t.Run("field index past the value arrays skips the frame", func(t *testing.T) {
		// Two named columns but only one value array present.
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[{"name":"Time"},{"name":"Line"}]},
			"data":{"values":[[1000]]}
		}]}}}`
		out, err := dsTestClient(t, http.StatusOK, body).LogQuery(context.Background(), "loki", "expr", from, to, 100)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(out) != 0 {
			t.Errorf("got %d entries, want 0 (lineIdx out of range)", len(out))
		}
	})

	t.Run("malformed time array skips the frame", func(t *testing.T) {
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[{"name":"Time"},{"name":"Line"}]},
			"data":{"values":[["not-a-number"],["a"]]}
		}]}}}`
		out, err := dsTestClient(t, http.StatusOK, body).LogQuery(context.Background(), "loki", "expr", from, to, 100)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(out) != 0 {
			t.Errorf("got %d entries, want 0 (time column unparseable)", len(out))
		}
	})

	t.Run("multiple frames concatenate in order", func(t *testing.T) {
		body := `{"results":{"A":{"frames":[
			{"schema":{"fields":[{"name":"Time"},{"name":"Line"}]},"data":{"values":[[1000],["first"]]}},
			{"schema":{"fields":[{"name":"Time"},{"name":"Line"}]},"data":{"values":[[2000],["second"]]}}
		]}}}`
		out, err := dsTestClient(t, http.StatusOK, body).LogQuery(context.Background(), "loki", "expr", from, to, 100)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(out) != 2 || out[0].Line != "first" || out[1].Line != "second" {
			t.Errorf("got %+v, want [first second]", out)
		}
	})
}

func TestLogQueryWithLabelsFrameParsing(t *testing.T) {
	from, to := time.Unix(0, 0), time.Unix(3600, 0)

	t.Run("dataplane labels column carries per-row structured metadata", func(t *testing.T) {
		// labels field values are an array of JSON objects, one per row.
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[{"name":"labels"},{"name":"timestamp"},{"name":"body"}]},
			"data":{"values":[
				[{"exception_type":"NPE","k8s_pod_name":"pod-a"},{"exception_type":"NPE","k8s_pod_name":"pod-b"}],
				[5000,6000],
				["line one","line two"]
			]}
		}]}}}`
		out, err := dsTestClient(t, http.StatusOK, body).LogQueryWithLabels(context.Background(), "loki", "expr", from, to, 100)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(out) != 2 {
			t.Fatalf("got %d entries, want 2: %+v", len(out), out)
		}
		if out[0].Line != "line one" || out[0].TimeMs != 5000 {
			t.Errorf("out[0] = %+v, want {5000 line one ...}", out[0])
		}
		if out[0].Labels["exception_type"] != "NPE" || out[0].Labels["k8s_pod_name"] != "pod-a" {
			t.Errorf("out[0].Labels = %+v, want exception_type=NPE pod=pod-a", out[0].Labels)
		}
		if out[1].Labels["k8s_pod_name"] != "pod-b" {
			t.Errorf("out[1].Labels = %+v, want pod-b", out[1].Labels)
		}
	})

	t.Run("labels column as JSON-encoded strings is decoded", func(t *testing.T) {
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[{"name":"labels"},{"name":"Time"},{"name":"Line"}]},
			"data":{"values":[
				["{\"exception_message\":\"boom\"}"],
				[7000],
				["raw"]
			]}
		}]}}}`
		out, err := dsTestClient(t, http.StatusOK, body).LogQueryWithLabels(context.Background(), "loki", "expr", from, to, 100)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(out) != 1 || out[0].Labels["exception_message"] != "boom" {
			t.Errorf("got %+v, want a single entry with exception_message=boom", out)
		}
	})

	t.Run("undecodable string-labels row falls back to frame-level labels", func(t *testing.T) {
		// The labels column is an array of JSON strings; the second is garbage.
		// The good row keeps its own labels; the garbage row must fall back to
		// the frame-level labels rather than being clobbered with an empty map.
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[
				{"name":"labels"},
				{"name":"Time"},
				{"name":"Line","labels":{"exception_type":"Frame","k8s_pod_name":"frame-pod"}}
			]},
			"data":{"values":[
				["{\"exception_type\":\"Row0\"}","not valid json"],
				[1000,2000],
				["a","b"]
			]}
		}]}}}`
		out, err := dsTestClient(t, http.StatusOK, body).LogQueryWithLabels(context.Background(), "loki", "expr", from, to, 100)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(out) != 2 {
			t.Fatalf("got %d entries, want 2: %+v", len(out), out)
		}
		if out[0].Labels["exception_type"] != "Row0" {
			t.Errorf("out[0].Labels = %+v, want its own exception_type=Row0", out[0].Labels)
		}
		// The undecodable row must inherit the frame-level labels, not lose them.
		if out[1].Labels["exception_type"] != "Frame" || out[1].Labels["k8s_pod_name"] != "frame-pod" {
			t.Errorf("out[1].Labels = %+v, want frame-level fallback (exception_type=Frame, pod=frame-pod)", out[1].Labels)
		}
	})

	t.Run("legacy frame-level labels apply to every row", func(t *testing.T) {
		// No labels column; labels ride on the line field's schema.
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[{"name":"Time"},{"name":"Line","labels":{"exception_type":"Timeout"}}]},
			"data":{"values":[[1000,2000],["a","b"]]}
		}]}}}`
		out, err := dsTestClient(t, http.StatusOK, body).LogQueryWithLabels(context.Background(), "loki", "expr", from, to, 100)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(out) != 2 {
			t.Fatalf("got %d entries, want 2", len(out))
		}
		if out[0].Labels["exception_type"] != "Timeout" || out[1].Labels["exception_type"] != "Timeout" {
			t.Errorf("frame labels not applied to both rows: %+v", out)
		}
	})

	t.Run("no labels anywhere degrades to nil labels, lines still returned", func(t *testing.T) {
		body := `{"results":{"A":{"frames":[{
			"schema":{"fields":[{"name":"timestamp"},{"name":"body"}]},
			"data":{"values":[[9000],["only body"]]}
		}]}}}`
		out, err := dsTestClient(t, http.StatusOK, body).LogQueryWithLabels(context.Background(), "loki", "expr", from, to, 100)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(out) != 1 || out[0].Line != "only body" {
			t.Fatalf("got %+v, want single {9000 only body}", out)
		}
		if out[0].Labels != nil {
			t.Errorf("labels = %+v, want nil", out[0].Labels)
		}
	})
}
