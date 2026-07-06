package plugin

import (
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// detectNPlusOne must group each trace's DB spans by normalized statement and
// emit a finding only when one fingerprint repeats at least the threshold times
// within a single trace — attributing it to that trace's endpoint.
func TestDetectNPlusOne(t *testing.T) {
	var offenders []dbSpan
	// 12 SELECTs with differing IN-arity → one normalized group, 12 repeats.
	for i := 0; i < 12; i++ {
		offenders = append(offenders, dbSpan{system: "postgresql", statement: "select * from person where id in (?, ?)", table: "person"})
	}
	// A couple of unrelated one-off queries in the same trace → below threshold.
	offenders = append(offenders,
		dbSpan{system: "postgresql", statement: "select count(*) from account"},
		dbSpan{system: "postgresql", statement: "update session set seen = now() where id = 7"},
	)

	traces := []nplusTrace{
		{traceID: "t1", endpoint: "GET /oppgaveliste.jsf", spans: offenders},
		// A clean trace: 3 different queries, none repeated → no finding.
		{traceID: "t2", endpoint: "GET /healthz", spans: []dbSpan{
			{system: "postgresql", statement: "select 1"},
			{system: "postgresql", statement: "select 2"},
			{system: "postgresql", statement: "select 3"},
		}},
	}

	got := detectNPlusOne(traces, 10, 50)
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 finding, got %d: %+v", len(got), got)
	}
	f := got[0]
	if f.RepeatCount != 12 {
		t.Errorf("repeat count = %d, want 12", f.RepeatCount)
	}
	if f.Statement != "select * from person where id in (?)" {
		t.Errorf("statement not normalized/collapsed: %q", f.Statement)
	}
	if f.Endpoint != "GET /oppgaveliste.jsf" {
		t.Errorf("endpoint wrong: %q", f.Endpoint)
	}
	if f.TraceID != "t1" {
		t.Errorf("traceID wrong: %q", f.TraceID)
	}
	if f.Table != "person" {
		t.Errorf("table not carried: %q", f.Table)
	}
	// 12 offenders + 2 one-offs observed in the trace.
	if f.TotalDBSpans != 14 {
		t.Errorf("totalDbSpans = %d, want 14", f.TotalDBSpans)
	}
	if !strings.Contains(strings.ToLower(f.Remediation), "join") {
		t.Errorf("SQL remediation should suggest a JOIN: %q", f.Remediation)
	}
}

// A single trace can hold several distinct N+1 offenders; each is its own
// finding, and findings are ordered worst-first (by repeat count).
func TestDetectNPlusOne_MultipleOffendersOrdered(t *testing.T) {
	var spans []dbSpan
	for i := 0; i < 10; i++ {
		spans = append(spans, dbSpan{system: "postgresql", statement: "select a from t1 where id = 1"})
	}
	for i := 0; i < 30; i++ {
		spans = append(spans, dbSpan{system: "redis", statement: "GET user:" + string(rune('a'+i))})
	}
	traces := []nplusTrace{{traceID: "t1", endpoint: "POST /submit", spans: spans}}

	got := detectNPlusOne(traces, 10, 50)
	if len(got) != 2 {
		t.Fatalf("expected 2 findings, got %d", len(got))
	}
	// Redis (30) must lead postgres (10).
	if got[0].DBSystem != "redis" || got[0].RepeatCount != 30 {
		t.Errorf("worst offender should be redis×30, got %+v", got[0])
	}
	if got[1].DBSystem != "postgresql" || got[1].RepeatCount != 10 {
		t.Errorf("second finding wrong: %+v", got[1])
	}
	// Redis keys are stripped to the verb fingerprint (PII-safe).
	if got[0].Statement != "GET ?" {
		t.Errorf("redis statement should be normalized to 'GET ?', got %q", got[0].Statement)
	}
	if !strings.Contains(got[0].Remediation, "MGET") {
		t.Errorf("redis remediation should suggest MGET/pipeline: %q", got[0].Remediation)
	}
}

// Just-below-threshold repetition must not be flagged.
func TestDetectNPlusOne_BelowThreshold(t *testing.T) {
	var spans []dbSpan
	for i := 0; i < 9; i++ {
		spans = append(spans, dbSpan{system: "postgresql", statement: "select * from t where id = 1"})
	}
	got := detectNPlusOne([]nplusTrace{{traceID: "t1", endpoint: "GET /x", spans: spans}}, 10, 50)
	if len(got) != 0 {
		t.Fatalf("9 repeats is below the threshold of 10, want 0 findings, got %d", len(got))
	}
}

func TestDetectNPlusOne_Limit(t *testing.T) {
	var traces []nplusTrace
	for tI := 0; tI < 5; tI++ {
		var spans []dbSpan
		for i := 0; i < 10; i++ {
			spans = append(spans, dbSpan{system: "postgresql", statement: "select x from t where id = 1"})
		}
		traces = append(traces, nplusTrace{traceID: "t" + strconv.Itoa(tI), endpoint: "GET /x", spans: spans})
	}
	got := detectNPlusOne(traces, 10, 3)
	if len(got) != 3 {
		t.Fatalf("limit not applied: got %d findings", len(got))
	}
}

func TestRemediationHint(t *testing.T) {
	cases := map[string]string{
		"postgresql":    "JOIN",
		"db2":           "JOIN",
		"other_sql":     "JOIN",
		"oracle":        "plan/index",
		"redis":         "MGET",
		"valkey":        "MGET",
		"mongodb":       "$in",
		"opensearch":    "multi-search",
		"elasticsearch": "multi-search",
	}
	for system, want := range cases {
		if hint := remediationHint(system); !strings.Contains(hint, want) {
			t.Errorf("remediationHint(%q) = %q, want it to mention %q", system, hint, want)
		}
	}
}

// parseNPlusOneResponse must group by trace, carry the root span as the
// endpoint, dedupe echoed spans, and pull the select()'ed attributes.
func TestParseNPlusOneResponse(t *testing.T) {
	body := []byte(`{
      "traces": [
        {
          "traceID": "abc",
          "rootServiceName": "gosys",
          "rootTraceName": "GET /oppgaveliste.jsf",
          "spanSet":  {"spans": [{"spanID": "s1", "durationNanos": "1000000", "attributes": [
            {"key": "db.system", "value": {"stringValue": "postgresql"}},
            {"key": "db.statement", "value": {"stringValue": "select * from t where id = 1"}}
          ]}]},
          "spanSets": [{"spans": [
            {"spanID": "s1", "durationNanos": "1000000", "attributes": [
              {"key": "db.system", "value": {"stringValue": "postgresql"}},
              {"key": "db.statement", "value": {"stringValue": "select * from t where id = 1"}}
            ]},
            {"spanID": "s2", "durationNanos": "2000000", "attributes": [
              {"key": "db.system", "value": {"stringValue": "postgresql"}},
              {"key": "db.statement", "value": {"stringValue": "select * from t where id = 2"}}
            ]}
          ]}]
        }
      ]
    }`)

	traces := parseNPlusOneResponse(body)
	if len(traces) != 1 {
		t.Fatalf("expected 1 trace, got %d", len(traces))
	}
	tr := traces[0]
	if tr.endpoint != "GET /oppgaveliste.jsf" {
		t.Errorf("endpoint wrong: %q", tr.endpoint)
	}
	// s1 echoed under both spanSet and spanSets → deduped to 1; plus s2 = 2.
	if len(tr.spans) != 2 {
		t.Fatalf("expected 2 deduped spans, got %d: %+v", len(tr.spans), tr.spans)
	}
}

func TestParseNPlusOneResponse_Garbage(t *testing.T) {
	if got := parseNPlusOneResponse([]byte("not json")); got != nil {
		t.Errorf("garbage should parse to nothing, got %v", got)
	}
}

func TestRootEndpointName(t *testing.T) {
	if got := rootEndpointName("gosys", "GET /x"); got != "GET /x" {
		t.Errorf("root trace name should win: %q", got)
	}
	if got := rootEndpointName("gosys", ""); got != "gosys" {
		t.Errorf("fallback to root service: %q", got)
	}
	if got := rootEndpointName("", ""); got != "unknown request" {
		t.Errorf("fallback to placeholder: %q", got)
	}
}

// The handler must reject an unconfigured/disallowed traces datasource with a
// graceful "unavailable" payload rather than proxying it.
func TestHandleDatabaseNPlusOne_UnconfiguredDatasource(t *testing.T) {
	a := &App{}
	req := httptest.NewRequest("GET", "/services/myns/mysvc/database/nplusone?tracesUid=evil", nil)
	req.SetPathValue("namespace", "myns")
	req.SetPathValue("service", "mysvc")
	rec := httptest.NewRecorder()

	a.handleDatabaseNPlusOne(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var resp NPlusOneResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Mode != "unavailable" {
		t.Errorf("mode = %q, want unavailable", resp.Mode)
	}
	if resp.Threshold != nplusoneRepeatThreshold {
		t.Errorf("threshold = %d, want %d", resp.Threshold, nplusoneRepeatThreshold)
	}
}
