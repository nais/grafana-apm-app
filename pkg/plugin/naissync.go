package plugin

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
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

// Deploy-marker pruning (#128). [annotations.api] retention is org-wide and
// must stay at keep-all so the triage event log survives (triage.go), which
// leaves deploy markers — one per deploy of every service, synced forever — as
// the growth driver of the shared annotations table (ADR-0001). Prune them
// here instead: keep the recent window (dashboard overlays, release health)
// plus the newest marker per namespace/service/env, which is all regression
// detection (#123) needs. Triage annotations are never touched.
const (
	deployRetention    = 90 * 24 * time.Hour
	deployPruneEvery   = 24 * time.Hour
	deployPruneJitter  = time.Hour
	deployPruneTimeout = 5 * time.Minute
	deployPruneLimit   = 1000
	// maxDeployPrunePages bounds one sweep to 20k markers; a larger backlog
	// drains over the following daily sweeps.
	maxDeployPrunePages = 20
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
		// Stagger the first sweep: a fleet-wide restart would otherwise fire
		// every replica's sweep at the same tick.
		lastPrune := time.Now().Add(-deployPruneEvery + rand.N(deployPruneJitter))
		for range ticker.C {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			if err := a.syncNaisDeployments(ctx, naisToken); err != nil {
				logger.Warn("Deploy sync failed", "error", err)
			}
			cancel()

			if time.Since(lastPrune) < deployPruneEvery {
				continue
			}
			ctx, cancel = context.WithTimeout(context.Background(), deployPruneTimeout)
			deleted, err := a.pruneDeployAnnotations(ctx)
			cancel()
			if err != nil {
				// Leave lastPrune alone so a failed sweep retries on the next
				// tick instead of standing down for a day.
				logger.Warn("Deploy annotation prune failed", "deleted", deleted, "error", err)
				continue
			}
			lastPrune = time.Now()
			if deleted > 0 {
				logger.Info("Pruned old deploy annotations", "deleted", deleted, "retention", deployRetention.String())
			}
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
	q.Set("from", "1")
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

// deployPruneKey is the identity a deploy marker is retained for: the service
// in its team's namespace, per environment. The namespace is part of the key
// because two teams may ship an app of the same name into the same
// environment — collapsing those would delete one team's only anchor.
// A marker missing either tag has no identity to anchor and is not prunable
// (ok=false); the "\x00" separator cannot appear in a Grafana tag, so no two
// distinct triples can produce the same key.
func deployPruneKey(tags []string) (string, bool) {
	service, namespace, env := "", "", ""
	for _, t := range tags {
		switch {
		case strings.HasPrefix(t, "service:"):
			service = strings.TrimPrefix(t, "service:")
		case strings.HasPrefix(t, "namespace:"):
			namespace = strings.TrimPrefix(t, "namespace:")
		case strings.HasPrefix(t, "env:"):
			env = strings.TrimPrefix(t, "env:")
		}
	}
	if service == "" || namespace == "" {
		return "", false
	}
	return namespace + "\x00" + service + "\x00" + env, true
}

// prunableDeploys walks one page of deploy markers newest-first and returns
// the IDs safe to delete: older than cutoffMs and not the newest marker for
// their namespace/service/env. keep carries the keys already anchored by a
// newer marker across pages, so callers must pass the same map every page.
//
// Anything that is not a deploy marker — or that also carries the triage tag,
// or that has no anchorable identity — is skipped: this is a delete path, and
// the triage event log is not ours.
//
// The page is re-sorted by (time desc, id asc) first. Grafana orders by epoch
// alone, so same-millisecond markers — which the HA sync writes by design when
// replicas race — come back in an arbitrary order; without the id tiebreak two
// replicas can anchor on different twins and delete each other's.
func prunableDeploys(anns []grafanaAnnotation, cutoffMs int64, keep map[string]bool) []int64 {
	ordered := slices.Clone(anns)
	slices.SortStableFunc(ordered, func(a, b grafanaAnnotation) int {
		if a.Time != b.Time {
			return cmp.Compare(b.Time, a.Time)
		}
		return cmp.Compare(a.ID, b.ID)
	})

	var ids []int64
	for _, ann := range ordered {
		if !hasTag(ann.Tags, deployAnnotationTag) || hasTag(ann.Tags, triageTag) || ann.ID == 0 {
			continue
		}
		key, ok := deployPruneKey(ann.Tags)
		if !ok {
			continue
		}
		anchored := keep[key]
		keep[key] = true
		if ann.Time >= cutoffMs || !anchored {
			continue // inside the retention window, or the newest for its key
		}
		ids = append(ids, ann.ID)
	}
	return ids
}

// pruneDeployAnnotations sweeps the org's deploy markers newest-first and
// deletes the ones outside the retention window that are not the newest for
// their service/env. Returns the number deleted.
func (a *App) pruneDeployAnnotations(ctx context.Context) (int, error) {
	store := a.triageStore(ctx) // same annotations HTTP plumbing
	now := time.Now()
	cutoff := now.Add(-deployRetention).UnixMilli()
	to := now.UnixMilli()
	keep := make(map[string]bool)
	deleted := 0

	for page := 0; page < maxDeployPrunePages; page++ {
		q := url.Values{}
		q.Add("tags", deployAnnotationTag)
		q.Set("limit", strconv.Itoa(deployPruneLimit))
		// from must be > 0: Grafana's store applies the time window only when
		// both bounds are positive (`if query.From > 0 && query.To > 0`), so
		// from=0 would drop `to` as well and every page would return the same
		// newest rows — the sweep would never reach the old tail.
		q.Set("from", "1")
		q.Set("to", strconv.FormatInt(to, 10))

		resp, err := store.do(ctx, http.MethodGet, "/api/annotations?"+q.Encode(), nil)
		if err != nil {
			return deleted, fmt.Errorf("listing deploy annotations: %w", err)
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
		_ = resp.Body.Close()
		if err != nil {
			return deleted, fmt.Errorf("reading deploy annotations: %w", err)
		}
		if resp.StatusCode != http.StatusOK {
			return deleted, fmt.Errorf("annotations API returned %d: %s", resp.StatusCode, truncateStr(string(raw)))
		}
		var anns []grafanaAnnotation
		if err := json.Unmarshal(raw, &anns); err != nil {
			return deleted, fmt.Errorf("unmarshaling deploy annotations: %w", err)
		}

		for _, id := range prunableDeploys(anns, cutoff, keep) {
			// One failed delete must not abandon the sweep: the rest of the
			// backlog is still prunable and the next sweep retries this one.
			if err := store.deleteAnnotation(ctx, id); err != nil {
				log.DefaultLogger.Warn("Deploy annotation delete failed", "id", id, "error", err)
				continue
			}
			deleted++
		}

		if len(anns) < deployPruneLimit {
			return deleted, nil
		}
		// Full page: step the window strictly below the oldest marker seen
		// (results are newest-first). Strict, so a marker kept as the newest
		// for its key is never re-offered on the next page — the cost is
		// skipping markers sharing that exact millisecond, which only ever
		// keeps one marker too many.
		oldest := anns[len(anns)-1].Time
		if oldest <= 1 || oldest > to {
			return deleted, nil
		}
		to = oldest - 1
	}
	return deleted, nil
}

func (s *annotationTriageStore) deleteAnnotation(ctx context.Context, id int64) error {
	resp, err := s.do(ctx, http.MethodDelete, "/api/annotations/"+strconv.FormatInt(id, 10), nil)
	if err != nil {
		return fmt.Errorf("deleting annotation %d: %w", id, err)
	}
	defer resp.Body.Close() //nolint:errcheck
	// Already gone (another replica pruned it) is success.
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("annotations API returned %d deleting %d: %s", resp.StatusCode, id, string(raw))
	}
	return nil
}
