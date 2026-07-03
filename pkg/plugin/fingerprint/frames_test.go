package fingerprint

import (
	"encoding/json"
	"os"
	"testing"
)

type frameFixtures struct {
	Description string `json:"description"`
	Cases       []struct {
		Path  string `json:"path"`
		InApp bool   `json:"inApp"`
		Note  string `json:"note"`
	} `json:"cases"`
}

// TestIsInAppFrameGolden pins the classifier to the shared fixture set also
// consumed by the TypeScript mirror (src/pages/tabs/frontend/frames.test.ts).
func TestIsInAppFrameGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/frames.json")
	if err != nil {
		t.Fatalf("reading fixtures: %v", err)
	}
	var fixtures frameFixtures
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatalf("parsing fixtures: %v", err)
	}
	if len(fixtures.Cases) == 0 {
		t.Fatal("no fixture cases")
	}

	for _, tc := range fixtures.Cases {
		if got := IsInAppFrame(tc.Path); got != tc.InApp {
			t.Errorf("IsInAppFrame(%q) = %v, want %v (%s)", tc.Path, got, tc.InApp, tc.Note)
		}
	}
}
