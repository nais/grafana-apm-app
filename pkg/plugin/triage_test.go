package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// mockAnnotationsAPI serves GET/POST /api/annotations backed by an in-memory
// slice, mimicking Grafana: reads are newest-first and AND-match all tags.
type mockAnnotationsAPI struct {
	anns []grafanaAnnotation
}

func (m *mockAnnotationsAPI) server(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			var body struct {
				Time int64    `json:"time"`
				Text string   `json:"text"`
				Tags []string `json:"tags"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			m.anns = append(m.anns, grafanaAnnotation{Time: body.Time, Text: body.Text, Tags: body.Tags})
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":1}`))
		case http.MethodGet:
			if strings.HasPrefix(r.URL.Path, "/api/admin") {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			want := r.URL.Query()["tags"]
			var out []grafanaAnnotation
			for i := len(m.anns) - 1; i >= 0; i-- { // newest first
				tags := make(map[string]bool, len(m.anns[i].Tags))
				for _, tg := range m.anns[i].Tags {
					tags[tg] = true
				}
				all := true
				for _, tg := range want {
					if !tags[tg] {
						all = false
						break
					}
				}
				if all {
					out = append(out, m.anns[i])
				}
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(out)
		}
	}))
}

func triageTestStore(t *testing.T) (*annotationTriageStore, *mockAnnotationsAPI) {
	t.Helper()
	mock := &mockAnnotationsAPI{}
	srv := mock.server(t)
	t.Cleanup(srv.Close)
	return &annotationTriageStore{
		grafanaURL: srv.URL,
		token:      "tok",
		httpClient: &http.Client{Timeout: 5 * time.Second},
	}, mock
}

func record(t *testing.T, s *annotationTriageStore, fp string, ev TriageEvent) {
	t.Helper()
	if err := s.Record(context.Background(), "team", "app", fp, ev); err != nil {
		t.Fatalf("record: %v", err)
	}
	// Annotation writes use wall-clock ms; space them out so ordering is stable.
	time.Sleep(2 * time.Millisecond)
}

func TestTriageFoldSemantics(t *testing.T) {
	s, _ := triageTestStore(t)
	ctx := context.Background()

	record(t, s, "v1:aaa", TriageEvent{Action: "resolve", Actor: "hans", ResolvedInVersion: "sha1"})
	record(t, s, "v1:aaa", TriageEvent{Action: "assign", Actor: "kari", Assignee: "ola"})
	record(t, s, "v1:bbb", TriageEvent{Action: "ignore", Actor: "hans"})
	record(t, s, "v1:bbb", TriageEvent{Action: "unresolve", Actor: "kari"})

	states, err := s.States(ctx, "team", "app")
	if err != nil {
		t.Fatalf("states: %v", err)
	}

	// assign after resolve keeps resolved AND carries the assignee
	a := states["v1:aaa"]
	if a.Status != "resolved" || a.Assignee != "ola" || a.ResolvedInVersion != "sha1" {
		t.Errorf("v1:aaa = %+v", a)
	}
	// unresolve after ignore → active
	if b := states["v1:bbb"]; b.Status != "active" {
		t.Errorf("v1:bbb = %+v", b)
	}
}

func TestTriageWritePayloadShape(t *testing.T) {
	s, mock := triageTestStore(t)
	record(t, s, "v1:abc123", TriageEvent{Action: "resolve", Actor: "hans"})

	if len(mock.anns) != 1 {
		t.Fatalf("expected 1 annotation, got %d", len(mock.anns))
	}
	ann := mock.anns[0]
	wantTags := map[string]bool{"nais-apm:triage": true, "app:team/app": true, "fp:v1-abc123": true}
	for _, tg := range ann.Tags {
		if !wantTags[tg] {
			t.Errorf("unexpected tag %q", tg)
		}
		delete(wantTags, tg)
	}
	if len(wantTags) != 0 {
		t.Errorf("missing tags: %v", wantTags)
	}
	var ev TriageEvent
	if err := json.Unmarshal([]byte(ann.Text), &ev); err != nil || ev.Schema != 1 || ev.Action != "resolve" || ev.Actor != "hans" {
		t.Errorf("unexpected event text %q (err %v)", ann.Text, err)
	}
}

func TestTriageHistoryOldestFirst(t *testing.T) {
	s, _ := triageTestStore(t)
	record(t, s, "v1:ccc", TriageEvent{Action: "resolve", Actor: "a"})
	record(t, s, "v1:ccc", TriageEvent{Action: "unresolve", Actor: "b"})
	record(t, s, "v1:ddd", TriageEvent{Action: "ignore", Actor: "c"}) // other fp — excluded

	events, err := s.History(context.Background(), "team", "app", "v1:ccc")
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(events) != 2 || events[0].Action != "resolve" || events[1].Action != "unresolve" {
		t.Errorf("unexpected history: %+v", events)
	}
}

func TestTriageActionValidation(t *testing.T) {
	mock := &mockAnnotationsAPI{}
	srv := mock.server(t)
	t.Cleanup(srv.Close)
	app := &App{grafanaURL: srv.URL, healthClient: &http.Client{Timeout: 5 * time.Second}}

	post := func(path, body string) int {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.SetPathValue("namespace", "team")
		req.SetPathValue("service", "app")
		req.SetPathValue("fingerprint", strings.TrimPrefix(strings.Split(path, "/triage/")[1], ""))
		rec := httptest.NewRecorder()
		app.handleTriageAction(rec, req)
		return rec.Code
	}

	if code := post("/services/team/app/triage/v1:abc", `{"action":"resolve"}`); code != http.StatusOK {
		t.Errorf("valid resolve → %d", code)
	}
	if code := post("/services/team/app/triage/v1:abc", `{"action":"explode"}`); code != http.StatusBadRequest {
		t.Errorf("invalid action → %d", code)
	}
	if code := post("/services/team/app/triage/NOT..VALID..FP", `{"action":"resolve"}`); code != http.StatusBadRequest {
		t.Errorf("invalid fingerprint → %d", code)
	}
}
