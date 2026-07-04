package plugin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestRequireEditor(t *testing.T) {
	app := &App{}
	cases := []struct {
		name     string
		role     string
		header   string
		wantPass bool
	}{
		{"admin passes", "Admin", "", true},
		{"editor passes", "Editor", "", true},
		{"viewer blocked", "Viewer", "", false},
		{"empty context falls back to header editor", "", "Editor", true},
		{"empty everywhere fails closed", "", "", false},
		{"unknown role fails closed", "Publisher", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/ops-watchlist", nil)
			if tc.role != "" {
				req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Role: tc.role}))
			}
			if tc.header != "" {
				req.Header.Set("X-Grafana-Org-Role", tc.header)
			}
			rec := httptest.NewRecorder()
			got := app.requireEditor(rec, req)
			if got != tc.wantPass {
				t.Errorf("requireEditor = %v, want %v (role=%q header=%q)", got, tc.wantPass, tc.role, tc.header)
			}
			if !tc.wantPass && rec.Code != http.StatusForbidden {
				t.Errorf("blocked call returned %d, want 403", rec.Code)
			}
		})
	}
}
