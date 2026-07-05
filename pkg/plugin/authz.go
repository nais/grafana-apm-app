package plugin

import (
	"net/http"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// requireEditor gates an endpoint that performs a privileged write with the
// plugin's service-account token. The resource proxy only guarantees the
// caller is an authenticated Grafana user (Viewer minimum), so without this a
// Viewer could drive an Admin/Editor-scoped action through the SA token
// (confused deputy). Returns true when the caller may proceed; otherwise it
// writes 403 and returns false.
//
// Roles are Grafana's org roles ("Admin", "Editor", "Viewer"); Admin and
// Editor pass. When the role is absent from the request context (some proxy
// paths don't populate it) we fail closed.
func (a *App) requireEditor(w http.ResponseWriter, req *http.Request) bool {
	role := ""
	if u := backend.UserFromContext(a.requestContext(req)); u != nil {
		role = u.Role
	}
	if role == "" {
		role = req.Header.Get("X-Grafana-Org-Role")
	}
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "admin", "editor":
		return true
	}
	http.Error(w, "forbidden: editor or admin role required", http.StatusForbidden)
	return false
}
