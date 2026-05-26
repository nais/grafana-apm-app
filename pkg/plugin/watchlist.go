package plugin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// OpsWatchlistEntry is a single namespace/service pair in the ops watchlist.
type OpsWatchlistEntry struct {
	Namespace string `json:"namespace"`
	Service   string `json:"service"`
}

// handleOpsWatchlist handles GET and POST requests for the shared ops watchlist.
// GET returns the current watchlist. POST replaces it.
// Any authenticated Grafana user can call this — the backend uses its service
// account token to update plugin settings on the user's behalf.
func (a *App) handleOpsWatchlist(w http.ResponseWriter, req *http.Request) {
	switch req.Method {
	case http.MethodGet:
		a.getOpsWatchlist(w, req)
	case http.MethodPost:
		a.setOpsWatchlist(w, req)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *App) getOpsWatchlist(w http.ResponseWriter, req *http.Request) {
	jsonData, err := a.fetchPluginJSONData(req)
	if err != nil {
		log.DefaultLogger.Error("Failed to fetch plugin settings", "error", err)
		http.Error(w, "failed to fetch plugin settings", http.StatusInternalServerError)
		return
	}

	watchlist := jsonData["opsWatchlist"]
	if watchlist == nil {
		watchlist = []any{}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(watchlist)
}

func (a *App) setOpsWatchlist(w http.ResponseWriter, req *http.Request) {
	var entries []OpsWatchlistEntry
	if err := json.NewDecoder(io.LimitReader(req.Body, 1<<20)).Decode(&entries); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Filter out incomplete entries
	valid := make([]OpsWatchlistEntry, 0, len(entries))
	for _, e := range entries {
		if e.Namespace != "" && e.Service != "" {
			valid = append(valid, e)
		}
	}

	// Fetch current jsonData, merge in the new watchlist, and save
	jsonData, err := a.fetchPluginJSONData(req)
	if err != nil {
		log.DefaultLogger.Error("Failed to fetch plugin settings for update", "error", err)
		http.Error(w, "failed to fetch plugin settings", http.StatusInternalServerError)
		return
	}

	if len(valid) > 0 {
		jsonData["opsWatchlist"] = valid
	} else {
		delete(jsonData, "opsWatchlist")
	}

	if err := a.savePluginJSONData(req, jsonData); err != nil {
		log.DefaultLogger.Error("Failed to save plugin settings", "error", err)
		http.Error(w, "failed to save plugin settings", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(valid)
}

// fetchPluginJSONData retrieves the plugin's current jsonData from the Grafana API.
func (a *App) fetchPluginJSONData(req *http.Request) (map[string]any, error) {
	token := a.resolveServiceToken(req.Context())
	url := fmt.Sprintf("%s/api/plugins/nais-apm-app/settings", a.grafanaURL)

	apiReq, err := http.NewRequestWithContext(req.Context(), http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if token != "" {
		apiReq.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := a.healthClient.Do(apiReq)
	if err != nil {
		return nil, fmt.Errorf("grafana API request failed: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("grafana API returned %d: %s", resp.StatusCode, string(body))
	}

	var pluginResp struct {
		JSONData map[string]any `json:"jsonData"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&pluginResp); err != nil {
		return nil, fmt.Errorf("failed to decode plugin settings: %w", err)
	}
	if pluginResp.JSONData == nil {
		pluginResp.JSONData = make(map[string]any)
	}
	return pluginResp.JSONData, nil
}

// savePluginJSONData updates the plugin's jsonData via the Grafana API.
func (a *App) savePluginJSONData(req *http.Request, jsonData map[string]any) error {
	token := a.resolveServiceToken(req.Context())
	url := fmt.Sprintf("%s/api/plugins/nais-apm-app/settings", a.grafanaURL)

	body, err := json.Marshal(map[string]any{
		"enabled":  true,
		"pinned":   true,
		"jsonData": jsonData,
	})
	if err != nil {
		return err
	}

	apiReq, err := http.NewRequestWithContext(req.Context(), http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	apiReq.Header.Set("Content-Type", "application/json")
	if token != "" {
		apiReq.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := a.healthClient.Do(apiReq)
	if err != nil {
		return fmt.Errorf("grafana API request failed: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("grafana API returned %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}
