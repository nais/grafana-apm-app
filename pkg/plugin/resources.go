package plugin

import (
	"net/http"
)

func (a *App) handlePing(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"message": "ok"}`))
}
