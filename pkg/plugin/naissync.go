package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// nais deploy sync (#64 Phase 2): polls the nais Console GraphQL API for
// successful deployments and mirrors them as Grafana deploy annotations
// (the #64 Phase 0 contract: tags nais-apm:deploy, service:, namespace:,
// env:, version:). This removes the per-team CI annotation step; the
// GitHub Action contract remains the escape hatch for non-nais producers.
//
// Idempotency: every synced annotation additionally carries
// deploy-id:<nais deployment id>; before writing, the poller checks for an
// existing annotation with that tag. HA replicas racing produce at most a
// duplicate marker (cosmetic) — annotations are not a correctness store here.

const (
	naisSyncInterval = 60 * time.Second
	naisSyncPageSize = 50
)

type naisDeployment struct {
	ID              string
	CreatedAt       time.Time
	EnvironmentName string
	CommitSha       string
	TriggerURL      string
	TeamSlug        string
	Resources       []struct{ Kind, Name string }
}

// startNaisDeploySync launches the background poller when a nais API URL and
// token are configured. Disabled silently otherwise (the local/dev case).
func (a *App) startNaisDeploySync(naisToken string) {
	if a.settings.NaisAPIURL == "" || naisToken == "" {
		return
	}
	logger := log.DefaultLogger.With("component", "nais-deploy-sync")
	logger.Info("nais deploy sync enabled", "url", a.settings.NaisAPIURL)
	go func() {
		ticker := time.NewTicker(naisSyncInterval)
		defer ticker.Stop()
		for range ticker.C {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			if err := a.syncNaisDeployments(ctx, naisToken); err != nil {
				logger.Warn("Deploy sync failed", "error", err)
			}
			cancel()
		}
	}()
}

// naisDeploysQuery fetches recent successful deployments. The nais schema
// exposes deployments on Query with statuses; commitSha is the release
// identity (there is no image-tag field on Deployment).
const naisDeploysQuery = `query($first: Int!) {
  deployments(first: $first) {
    nodes {
      id createdAt environmentName commitSha triggerUrl teamSlug
      resources(first: 10) { nodes { kind name } }
      statuses(first: 1) { nodes { state } }
    }
  }
}`

func (a *App) fetchNaisDeployments(ctx context.Context, naisToken string) ([]naisDeployment, error) {
	body, err := json.Marshal(map[string]any{
		"query":     naisDeploysQuery,
		"variables": map[string]any{"first": naisSyncPageSize},
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.settings.NaisAPIURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+naisToken)

	resp, err := a.healthClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("querying nais API: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("nais API returned %d: %s", resp.StatusCode, truncateStr(string(raw)))
	}

	var envelope struct {
		Data struct {
			Deployments struct {
				Nodes []struct {
					ID              string    `json:"id"`
					CreatedAt       time.Time `json:"createdAt"`
					EnvironmentName string    `json:"environmentName"`
					CommitSha       string    `json:"commitSha"`
					TriggerURL      string    `json:"triggerUrl"`
					TeamSlug        string    `json:"teamSlug"`
					Resources       struct {
						Nodes []struct{ Kind, Name string } `json:"nodes"`
					} `json:"resources"`
					Statuses struct {
						Nodes []struct{ State string } `json:"nodes"`
					} `json:"statuses"`
				} `json:"nodes"`
			} `json:"deployments"`
		} `json:"data"`
		Errors []struct{ Message string } `json:"errors"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("unmarshaling nais response: %w", err)
	}
	if len(envelope.Errors) > 0 {
		return nil, fmt.Errorf("nais API error: %s", envelope.Errors[0].Message)
	}

	var out []naisDeployment
	for _, n := range envelope.Data.Deployments.Nodes {
		if len(n.Statuses.Nodes) == 0 || n.Statuses.Nodes[0].State != "SUCCESS" {
			continue
		}
		d := naisDeployment{
			ID:              n.ID,
			CreatedAt:       n.CreatedAt,
			EnvironmentName: n.EnvironmentName,
			CommitSha:       n.CommitSha,
			TriggerURL:      n.TriggerURL,
			TeamSlug:        n.TeamSlug,
		}
		for _, r := range n.Resources.Nodes {
			d.Resources = append(d.Resources, struct{ Kind, Name string }{r.Kind, r.Name})
		}
		out = append(out, d)
	}
	return out, nil
}

func (a *App) syncNaisDeployments(ctx context.Context, naisToken string) error {
	deployments, err := a.fetchNaisDeployments(ctx, naisToken)
	if err != nil {
		return err
	}
	store := &annotationTriageStore{ // reuse the annotations HTTP plumbing
		grafanaURL: a.grafanaURL,
		token:      a.resolveServiceToken(ctx),
		httpClient: a.healthClient,
	}
	for _, d := range deployments {
		if err := a.syncOneDeployment(ctx, store, d); err != nil {
			log.DefaultLogger.Warn("Deploy annotation sync failed", "deploy", d.ID, "error", err)
		}
	}
	return nil
}

func (a *App) syncOneDeployment(ctx context.Context, store *annotationTriageStore, d naisDeployment) error {
	// Application/Job resources carry the service name.
	service := ""
	for _, r := range d.Resources {
		if r.Kind == "Application" || r.Kind == "Job" || r.Kind == "Naisjob" {
			service = r.Name
			break
		}
	}
	if service == "" || d.CommitSha == "" {
		return nil // nothing to mark
	}

	// Idempotency probe by deploy-id tag.
	q := url.Values{}
	q.Add("tags", "deploy-id:"+d.ID)
	q.Set("limit", "1")
	q.Set("from", "0")
	q.Set("to", strconv.FormatInt(time.Now().UnixMilli(), 10))
	resp, err := store.do(ctx, http.MethodGet, "/api/annotations?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	existing, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	_ = resp.Body.Close()
	if err == nil && resp.StatusCode == http.StatusOK {
		var found []json.RawMessage
		if json.Unmarshal(existing, &found) == nil && len(found) > 0 {
			return nil // already synced
		}
	}

	text := fmt.Sprintf("Deployed %s %.7s", service, d.CommitSha)
	if d.TriggerURL != "" {
		text += " — " + d.TriggerURL
	}
	payload, err := json.Marshal(map[string]any{
		"time": d.CreatedAt.UnixMilli(),
		"text": text,
		"tags": []string{
			"nais-apm:deploy",
			"service:" + service,
			"namespace:" + d.TeamSlug,
			"env:" + d.EnvironmentName,
			"version:" + d.CommitSha,
			"deploy-id:" + d.ID,
		},
	})
	if err != nil {
		return err
	}
	wresp, err := store.do(ctx, http.MethodPost, "/api/annotations", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	defer wresp.Body.Close() //nolint:errcheck
	if wresp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(wresp.Body, 256))
		return fmt.Errorf("annotations API returned %d: %s", wresp.StatusCode, string(raw))
	}
	return nil
}
