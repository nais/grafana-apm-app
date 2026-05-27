package plugin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// OpsWatchlistEntry is a single namespace/service pair in the ops watchlist.
type OpsWatchlistEntry struct {
	Namespace string `json:"namespace"`
	Service   string `json:"service"`
}

// watchlistMu serializes write operations to prevent concurrent read-modify-write races.
var watchlistMu sync.Mutex

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
	settings, err := a.fetchPluginSettings(req)
	if err != nil {
		log.DefaultLogger.Error("Failed to fetch plugin settings", "error", err)
		http.Error(w, "failed to fetch plugin settings", http.StatusInternalServerError)
		return
	}

	watchlist := settings.JSONData["opsWatchlist"]
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

	// Serialize writes to prevent concurrent read-modify-write races
	watchlistMu.Lock()
	defer watchlistMu.Unlock()

	// Fetch current settings (includes jsonData and secureJsonFields)
	settings, err := a.fetchPluginSettings(req)
	if err != nil {
		log.DefaultLogger.Error("Failed to fetch plugin settings for update", "error", err)
		http.Error(w, "failed to fetch plugin settings", http.StatusInternalServerError)
		return
	}

	if len(valid) > 0 {
		settings.JSONData["opsWatchlist"] = valid
	} else {
		delete(settings.JSONData, "opsWatchlist")
	}

	if err := a.savePluginSettings(req, settings); err != nil {
		log.DefaultLogger.Error("Failed to save plugin settings", "error", err)
		http.Error(w, "failed to save plugin settings", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(valid)
}

// pluginSettings holds the subset of plugin settings needed for read-modify-write.
type pluginSettings struct {
	Enabled         bool              `json:"enabled"`
	Pinned          bool              `json:"pinned"`
	JSONData        map[string]any    `json:"jsonData"`
	SecureJSONFields map[string]bool  `json:"secureJsonFields"`
}

// fetchPluginSettings retrieves the plugin's current settings from the Grafana API.
func (a *App) fetchPluginSettings(req *http.Request) (*pluginSettings, error) {
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

	var settings pluginSettings
	if err := json.NewDecoder(resp.Body).Decode(&settings); err != nil {
		return nil, fmt.Errorf("failed to decode plugin settings: %w", err)
	}
	if settings.JSONData == nil {
		settings.JSONData = make(map[string]any)
	}
	return &settings, nil
}

// savePluginSettings updates the plugin's settings via the Grafana API.
// It preserves secureJsonFields to avoid wiping existing secrets.
func (a *App) savePluginSettings(req *http.Request, settings *pluginSettings) error {
	token := a.resolveServiceToken(req.Context())
	url := fmt.Sprintf("%s/api/plugins/nais-apm-app/settings", a.grafanaURL)

	// Build the save payload preserving secure fields.
	// When secureJsonFields are included with true values, Grafana keeps
	// existing secrets intact without requiring us to re-send the actual values.
	payload := map[string]any{
		"enabled":  settings.Enabled,
		"pinned":   settings.Pinned,
		"jsonData": settings.JSONData,
	}
	if len(settings.SecureJSONFields) > 0 {
		payload["secureJsonFields"] = settings.SecureJSONFields
	}

	body, err := json.Marshal(payload)
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
