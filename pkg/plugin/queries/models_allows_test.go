package queries

import "testing"

func TestEnvAwareDataSourceAllows(t *testing.T) {
	ds := EnvAwareDataSource{
		UID: "loki-default",
		ByEnvironment: map[string]DataSourceRef{
			"prod": {UID: "loki-prod"},
			"dev":  {UID: "loki-dev"},
		},
	}
	cases := map[string]bool{
		"loki-default": true,
		"loki-prod":    true,
		"loki-dev":     true,
		"loki-other":   false, // an arbitrary UID the SA might reach
		"":             false,
		"admin":        false,
	}
	for uid, want := range cases {
		if got := ds.Allows(uid); got != want {
			t.Errorf("Allows(%q) = %v, want %v", uid, got, want)
		}
	}

	// No overrides configured: only the default is allowed.
	only := EnvAwareDataSource{UID: "solo"}
	if !only.Allows("solo") || only.Allows("nope") {
		t.Error("default-only allowlist misbehaved")
	}
}
