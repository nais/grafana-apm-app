package fingerprint

import (
	"strings"
	"testing"
)

func TestNormalize(t *testing.T) {
	tests := []struct {
		name  string
		in    string
		want  string
	}{
		{"uuid", "Invalid søknad 8f3a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8", "Invalid søknad <uuid>"},
		{"url with path and ids", `Failed to fetch https://api.nav.no/soknad/12345?token=abc from upstream`, "Failed to fetch <url> from upstream"},
		{"email", "User bruker@nav.no not found", "User <email> not found"},
		{"iso timestamp", "Deadline was 2026-07-03T10:15:30Z exceeded", "Deadline was <ts> exceeded"},
		{"ip address", "connect ECONNREFUSED 10.0.0.1", "connect ECONNREFUSED <ip>"},
		{"long hex run", "Trace deadbeefcafe1234 aborted", "Trace <hex> aborted"},
		{"digit runs become num", "Retried 17 times for order 991234", "Retried <num> times for order <num>"},
		{"single digits kept", "Expected 2 items, got 3", "Expected 2 items, got 3"},
		{"http status preserved", "HTTP 404 from downstream", "HTTP 404 from downstream"},
		{"status= preserved", "status=503 while calling backend", "status=503 while calling backend"},
		{"code colon preserved", "code: 429 too many requests", "code: 429 too many requests"},
		{"whitespace collapsed", "  a\n\t b   c ", "a b c"},
		{"fnr-like masked as num", "Ugyldig fnr 12345678901", "Ugyldig fnr <num>"},
		{"norwegian text unchanged", "Kunne ikke hente søknaden", "Kunne ikke hente søknaden"},
		{"empty", "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Normalize(tc.in); got != tc.want {
				t.Errorf("Normalize(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestNormalizeTruncatesOnRuneBoundary(t *testing.T) {
	in := strings.Repeat("æ", 400) // 2 bytes per rune
	got := Normalize(in)
	if len(got) > maxTitleLen {
		t.Errorf("normalized length %d exceeds max %d", len(got), maxTitleLen)
	}
	for _, r := range got {
		if r != 'æ' {
			t.Fatalf("truncation corrupted runes: found %q", r)
		}
	}
}

func TestComputeTiers(t *testing.T) {
	tests := []struct {
		name     string
		event    Event
		wantTier Tier
	}{
		{"override wins over everything", Event{ContextFingerprint: "checkout|payment", Type: "TypeError", Value: "x", UpstreamHash: "1"}, TierOverride},
		{"type+message", Event{Type: "TypeError", Value: "Failed to fetch", UpstreamHash: "1"}, TierTypeMessage},
		{"message only", Event{Value: "Failed to fetch", UpstreamHash: "1"}, TierMessage},
		{"hash passthrough", Event{UpstreamHash: "17293"}, TierUpstreamHash},
		{"whitespace-only value falls through", Event{Value: "   ", UpstreamHash: "17293"}, TierUpstreamHash},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Compute(tc.event)
			if got.Tier != tc.wantTier {
				t.Errorf("tier = %d, want %d", got.Tier, tc.wantTier)
			}
			if !strings.HasPrefix(got.Value, Version+":") {
				t.Errorf("fingerprint %q missing version prefix", got.Value)
			}
			if len(got.Value) != len(Version)+1+16 {
				t.Errorf("fingerprint %q has unexpected length", got.Value)
			}
		})
	}
}

func TestComputeGroupsDynamicMessages(t *testing.T) {
	a := Compute(Event{Type: "Error", Value: "Invalid søknad 8f3a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8"})
	b := Compute(Event{Type: "Error", Value: "Invalid søknad 91bb0000-1111-2222-3333-444455556666"})
	if a.Value != b.Value {
		t.Errorf("same logical error with different UUIDs produced different fingerprints: %q vs %q", a.Value, b.Value)
	}
	if a.Title != "Error: Invalid søknad <uuid>" {
		t.Errorf("unexpected title %q", a.Title)
	}
}

func TestComputeSeparatesByType(t *testing.T) {
	a := Compute(Event{Type: "TypeError", Value: "x is undefined"})
	b := Compute(Event{Type: "CustomError", Value: "x is undefined"})
	if a.Value == b.Value {
		t.Error("different exception types must not share a fingerprint")
	}
}

func TestComputeSeparatesHTTPStatusClasses(t *testing.T) {
	a := Compute(Event{Type: "Error", Value: "HTTP 404 from downstream"})
	b := Compute(Event{Type: "Error", Value: "HTTP 500 from downstream"})
	if a.Value == b.Value {
		t.Error("HTTP 404 and HTTP 500 must group separately")
	}
}

func TestComputeDeterministic(t *testing.T) {
	e := Event{Type: "TypeError", Value: "Failed to fetch https://api.nav.no/x id 12345"}
	first := Compute(e)
	for range 10 {
		if got := Compute(e); got != first {
			t.Fatalf("Compute is not deterministic: %+v vs %+v", got, first)
		}
	}
}

func TestTiersDoNotCollide(t *testing.T) {
	// The same string via different tiers must produce different fingerprints.
	msg := "Failed to fetch"
	viaMessage := Compute(Event{Value: msg})
	viaOverride := Compute(Event{ContextFingerprint: Normalize(msg)})
	if viaMessage.Value == viaOverride.Value {
		t.Error("tier must participate in the hash")
	}
}
