package plugin

import (
	"net/http"
)

func (a *App) handlePing(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"message": "ok"}`))
}
