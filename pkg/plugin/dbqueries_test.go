package plugin

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAggregateTopQueries(t *testing.T) {
	spans := []dbSpan{
		// Three logically-identical SELECTs (IN-arity differs) → one group.
		{system: "oracle", statement: "select x from t where id in (?)", durationMs: 10, traceID: "t1", table: "t"},
		{system: "oracle", statement: "select x from t where id in (?, ?)", durationMs: 20, traceID: "t2"},
		{system: "oracle", statement: "select x from t where id in (?, ?, ?)", durationMs: 30, traceID: "t3"},
		// A different, cheaper query → its own group.
		{system: "postgresql", statement: "update u set n = 'a' where id = 5", durationMs: 5, traceID: "t4"},
		// Redis calls with different keys → one group.
		{system: "redis", statement: "GET a", durationMs: 1, traceID: "t5"},
		{system: "redis", statement: "GET b", durationMs: 3, traceID: "t6"},
		// Empty statement → skipped.
		{system: "postgresql", statement: "", durationMs: 99, traceID: "t7"},
	}

	got := aggregateTopQueries(spans, 50)

	if len(got) != 3 {
		t.Fatalf("expected 3 groups, got %d: %+v", len(got), got)
	}
	// Default ordering is by total time desc; the oracle group (60ms) leads.
	top := got[0]
	if top.DBSystem != "oracle" || top.Count != 3 || top.TotalTimeMs != 60 {
		t.Errorf("top group wrong: %+v", top)
	}
	if top.Statement != "select x from t where id in (?)" {
		t.Errorf("top statement not normalized/collapsed: %q", top.Statement)
	}
	if top.AvgTimeMs != 20 {
		t.Errorf("avg wrong: %v", top.AvgTimeMs)
	}
	if top.Table != "t" {
		t.Errorf("table not carried through: %q", top.Table)
	}
	if top.TraceID != "t1" {
		t.Errorf("representative traceID wrong: %q", top.TraceID)
	}

	// Redis group must be present and normalized to GET ?.
	var redis *TopQuery
	for i := range got {
		if got[i].DBSystem == "redis" {
			redis = &got[i]
		}
	}
	if redis == nil || redis.Statement != "GET ?" || redis.Count != 2 {
		t.Errorf("redis group wrong: %+v", redis)
	}
}

func TestAggregateTopQueries_Limit(t *testing.T) {
	var spans []dbSpan
	for i := 0; i < 10; i++ {
		spans = append(spans, dbSpan{system: "postgresql", statement: "select " + string(rune('a'+i)) + " from t", durationMs: 1})
	}
	got := aggregateTopQueries(spans, 3)
	if len(got) != 3 {
		t.Fatalf("limit not applied: got %d groups", len(got))
	}
}

func TestPercentile95(t *testing.T) {
	vals := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	// Nearest-rank on the 0-indexed sorted sample: int((10-1)*0.95) = 8 → 9.
	if p := percentile95(vals); p != 9 {
		t.Errorf("p95 = %v, want 9", p)
	}
	if p := percentile95(nil); p != 0 {
		t.Errorf("p95 of empty = %v, want 0", p)
	}
	if p := percentile95([]float64{42}); p != 42 {
		t.Errorf("p95 of single = %v, want 42", p)
	}
}

// parseDBSearchResponse must dedupe spans echoed under both spanSet and spanSets,
// pull the select()'ed attributes, and convert durationNanos to ms.
func TestParseDBSearchResponse(t *testing.T) {
	body := []byte(`{
      "traces": [
        {
          "traceID": "abc",
          "spanSet":  {"spans": [{"spanID": "s1", "durationNanos": "677456", "attributes": [
            {"key": "db.system", "value": {"stringValue": "mongodb"}},
            {"key": "db.statement", "value": {"stringValue": "{\"find\": \"t\"}"}}
          ]}]},
          "spanSets": [{"spans": [{"spanID": "s1", "durationNanos": "677456", "attributes": [
            {"key": "db.system", "value": {"stringValue": "mongodb"}},
            {"key": "db.statement", "value": {"stringValue": "{\"find\": \"t\"}"}}
          ]}]}]
        },
        {
          "traceID": "def",
          "spanSets": [{"spans": [{"spanID": "s2", "durationNanos": "1500000", "attributes": [
            {"key": "db.system", "value": {"stringValue": "postgresql"}},
            {"key": "db.sql.table", "value": {"stringValue": "users"}},
            {"key": "db.statement", "value": {"stringValue": "select 1"}}
          ]}]}]
        }
      ]
    }`)

	spans, traceCount := parseDBSearchResponse(body)
	if traceCount != 2 {
		t.Errorf("traceCount = %d, want 2", traceCount)
	}
	if len(spans) != 2 {
		t.Fatalf("expected 2 deduped spans, got %d: %+v", len(spans), spans)
	}
	if spans[0].system != "mongodb" || spans[0].traceID != "abc" || spans[0].durationMs != 0.677456 {
		t.Errorf("span0 wrong: %+v", spans[0])
	}
	if spans[1].table != "users" || spans[1].durationMs != 1.5 {
		t.Errorf("span1 wrong: %+v", spans[1])
	}
}

func TestParseDBSearchResponse_Garbage(t *testing.T) {
	spans, n := parseDBSearchResponse([]byte("not json"))
	if spans != nil || n != 0 {
		t.Errorf("garbage should parse to nothing, got %v %d", spans, n)
	}
}

func TestClampWindow(t *testing.T) {
	to := time.Unix(1_000_000, 0)
	// Wide range clamps to to-cap.
	from := to.Add(-6 * time.Hour)
	if got := clampWindow(from, to, time.Hour); !got.Equal(to.Add(-time.Hour)) {
		t.Errorf("wide window not clamped: %v", got)
	}
	// Narrow range is left untouched.
	narrow := to.Add(-10 * time.Minute)
	if got := clampWindow(narrow, to, time.Hour); !got.Equal(narrow) {
		t.Errorf("narrow window altered: %v", got)
	}
}

// The handler must reject an unconfigured/disallowed traces datasource with a
// graceful "unavailable" payload rather than proxying it.
func TestHandleDatabaseQueries_UnconfiguredDatasource(t *testing.T) {
	a := &App{}
	req := httptest.NewRequest("GET", "/services/myns/mysvc/database/queries?tracesUid=evil", nil)
	req.SetPathValue("namespace", "myns")
	req.SetPathValue("service", "mysvc")
	rec := httptest.NewRecorder()

	a.handleDatabaseQueries(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var resp TopQueriesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Mode != "unavailable" {
		t.Errorf("mode = %q, want unavailable", resp.Mode)
	}
}
