package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// pv builds a PromResult with the given labels and float value.
func pv(labels map[string]string, value string) queries.PromResult {
	return queries.PromResult{Metric: labels, Value: queries.NewPromValue(0, value)}
}

// pvSchedule clones labels and adds a cron schedule (for kube_cronjob_info).
func pvSchedule(labels map[string]string, schedule string) queries.PromResult {
	m := make(map[string]string, len(labels)+1)
	for k, v := range labels {
		m[k] = v
	}
	m[ksmLabelSchedule] = schedule
	return pv(m, "1")
}

// pvReason clones labels and adds a failure reason (for kube_job_status_failed).
func pvReason(labels map[string]string, reason, value string) queries.PromResult {
	m := make(map[string]string, len(labels)+1)
	for k, v := range labels {
		m[k] = v
	}
	m[ksmLabelReason] = reason
	return pv(m, value)
}

func findJob(jobs []JobEntry, name string) *JobEntry {
	for i := range jobs {
		if jobs[i].Name == name {
			return &jobs[i]
		}
	}
	return nil
}

func TestAggregateJobsUnavailable(t *testing.T) {
	resp := aggregateJobs(map[string][]queries.PromResult{})
	if resp.Available {
		t.Fatalf("Available = true, want false when no KSM series present")
	}
	if len(resp.Jobs) != 0 {
		t.Errorf("Jobs = %d, want 0", len(resp.Jobs))
	}
	if resp.Note == "" {
		t.Errorf("expected an explanatory Note when unavailable")
	}
}

func TestAggregateJobsStreakAndStatus(t *testing.T) {
	cj := func(cronjob string) map[string]string {
		return map[string]string{ksmLabelCluster: "dev", ksmLabelNamespace: "team-a", ksmLabelCronjob: cronjob}
	}
	// Child job labels joined to a CronJob owner.
	child := func(jobName, owner string) map[string]string {
		return map[string]string{
			ksmLabelCluster: "dev", ksmLabelNamespace: "team-a", ksmLabelJobName: jobName,
			ksmLabelOwnerKind: ownerKindCronJob, ksmLabelOwnerName: owner,
		}
	}
	jl := func(jobName string) map[string]string {
		return map[string]string{ksmLabelCluster: "dev", ksmLabelNamespace: "team-a", ksmLabelJobName: jobName}
	}

	rm := map[string][]queries.PromResult{
		"cronjobInfo": {
			pvSchedule(cj("healthy"), "0 * * * *"),
			pvSchedule(cj("broken"), "*/5 * * * *"),
			pvSchedule(cj("neverran"), "0 0 * * *"),
		},
		"lastSchedule": {pv(cj("healthy"), "1000")},
		"nextSchedule": {pv(cj("healthy"), "5000"), pv(cj("broken"), "6000")},
		"jobOwner": {
			// healthy: newest succeeded, middle failed, oldest succeeded → streak 0, ok
			pv(child("healthy-3", "healthy"), "1"),
			pv(child("healthy-2", "healthy"), "1"),
			pv(child("healthy-1", "healthy"), "1"),
			// broken: two newest failed, then success → streak 2, failing
			pv(child("broken-3", "broken"), "1"),
			pv(child("broken-2", "broken"), "1"),
			pv(child("broken-1", "broken"), "1"),
		},
		"jobSucceeded": {
			pv(jl("healthy-3"), "1"), pv(jl("healthy-2"), "0"), pv(jl("healthy-1"), "1"),
			pv(jl("broken-3"), "0"), pv(jl("broken-2"), "0"), pv(jl("broken-1"), "1"),
		},
		"jobFailed": {
			pv(jl("healthy-3"), "0"),
			pvReason(jl("healthy-2"), "BackoffLimitExceeded", "1"),
			pv(jl("healthy-1"), "0"),
			pvReason(jl("broken-3"), "DeadlineExceeded", "1"),
			pvReason(jl("broken-2"), "Evicted", "1"),
			pv(jl("broken-1"), "0"),
		},
		"jobStart": {
			pv(jl("healthy-3"), "3000"), pv(jl("healthy-2"), "2000"), pv(jl("healthy-1"), "1000"),
			pv(jl("broken-3"), "3000"), pv(jl("broken-2"), "2000"), pv(jl("broken-1"), "1000"),
		},
		"jobCompletion": {
			pv(jl("healthy-3"), "3030"), pv(jl("healthy-1"), "1020"),
			pv(jl("broken-1"), "1010"),
		},
	}

	resp := aggregateJobs(rm)
	if !resp.Available {
		t.Fatalf("Available = false, want true")
	}

	// Failing entries sort first.
	if resp.Jobs[0].Name != "broken" {
		t.Errorf("first entry = %q, want broken (failing sorts first)", resp.Jobs[0].Name)
	}

	healthy := findJob(resp.Jobs, "healthy")
	if healthy == nil {
		t.Fatal("healthy entry missing")
	}
	if healthy.Status != "ok" || healthy.FailureStreak != 0 {
		t.Errorf("healthy status=%q streak=%d, want ok/0", healthy.Status, healthy.FailureStreak)
	}
	if healthy.LastRun == nil || healthy.LastRun.Outcome != "succeeded" {
		t.Errorf("healthy lastRun = %+v, want succeeded", healthy.LastRun)
	}
	if healthy.LastRun.DurationSec != 30 {
		t.Errorf("healthy last-run duration = %ds, want 30s", healthy.LastRun.DurationSec)
	}
	if healthy.RunCount != 3 {
		t.Errorf("healthy runCount = %d, want 3", healthy.RunCount)
	}
	if healthy.Schedule != "0 * * * *" {
		t.Errorf("healthy schedule = %q, want cron expr", healthy.Schedule)
	}
	if healthy.NextScheduleMs != 5000000 {
		t.Errorf("healthy nextScheduleMs = %d, want 5000000", healthy.NextScheduleMs)
	}

	broken := findJob(resp.Jobs, "broken")
	if broken == nil {
		t.Fatal("broken entry missing")
	}
	if broken.Status != "failing" || broken.FailureStreak != 2 {
		t.Errorf("broken status=%q streak=%d, want failing/2", broken.Status, broken.FailureStreak)
	}
	if broken.LastRun == nil || broken.LastRun.Outcome != "failed" || broken.LastRun.Reason != "DeadlineExceeded" {
		t.Errorf("broken lastRun = %+v, want failed/DeadlineExceeded", broken.LastRun)
	}

	never := findJob(resp.Jobs, "neverran")
	if never == nil {
		t.Fatal("neverran entry missing")
	}
	if never.Status != "unknown" || never.LastRun != nil || never.RunCount != 0 {
		t.Errorf("neverran = %+v, want unknown/no-run/0", never)
	}
}

// TestAggregateJobsRunningNewest verifies an in-flight newest run doesn't reset
// the streak — the prior failed run still surfaces as failing.
func TestAggregateJobsRunningNewest(t *testing.T) {
	child := func(jobName string) map[string]string {
		return map[string]string{
			ksmLabelCluster: "prod", ksmLabelNamespace: "team-b", ksmLabelJobName: jobName,
			ksmLabelOwnerKind: ownerKindCronJob, ksmLabelOwnerName: "cj",
		}
	}
	jl := func(jobName string) map[string]string {
		return map[string]string{ksmLabelCluster: "prod", ksmLabelNamespace: "team-b", ksmLabelJobName: jobName}
	}
	rm := map[string][]queries.PromResult{
		"cronjobInfo": {pvSchedule(map[string]string{ksmLabelCluster: "prod", ksmLabelNamespace: "team-b", ksmLabelCronjob: "cj"}, "0 * * * *")},
		"jobOwner":    {pv(child("cj-2"), "1"), pv(child("cj-1"), "1")},
		// cj-2 newest: running (no succeeded/failed, start but no completion).
		"jobSucceeded":  {pv(jl("cj-2"), "0"), pv(jl("cj-1"), "0")},
		"jobFailed":     {pv(jl("cj-2"), "0"), pvReason(jl("cj-1"), "Evicted", "1")},
		"jobStart":      {pv(jl("cj-2"), "2000"), pv(jl("cj-1"), "1000")},
		"jobCompletion": {},
	}
	resp := aggregateJobs(rm)
	e := findJob(resp.Jobs, "cj")
	if e == nil {
		t.Fatal("cj entry missing")
	}
	if e.LastRun == nil || e.LastRun.Outcome != "running" {
		t.Errorf("lastRun = %+v, want running", e.LastRun)
	}
	if e.Status != "failing" || e.FailureStreak != 1 {
		t.Errorf("status=%q streak=%d, want failing/1 (running newest skipped)", e.Status, e.FailureStreak)
	}
}

// TestAggregateJobsStandalone verifies one-shot jobs (no CronJob owner) render
// as their own Job rows.
func TestAggregateJobsStandalone(t *testing.T) {
	jl := func(jobName string) map[string]string {
		return map[string]string{ksmLabelCluster: "dev", ksmLabelNamespace: "team-c", ksmLabelJobName: jobName}
	}
	rm := map[string][]queries.PromResult{
		"jobOwner":      {pv(jl("oneshot"), "1")}, // no owner_kind label → standalone
		"jobSucceeded":  {pv(jl("oneshot"), "0")},
		"jobFailed":     {pvReason(jl("oneshot"), "BackoffLimitExceeded", "1")},
		"jobStart":      {pv(jl("oneshot"), "1000")},
		"jobCompletion": {},
	}
	resp := aggregateJobs(rm)
	if !resp.Available {
		t.Fatalf("Available = false, want true")
	}
	e := findJob(resp.Jobs, "oneshot")
	if e == nil {
		t.Fatal("oneshot entry missing")
	}
	if e.Kind != "Job" {
		t.Errorf("kind = %q, want Job", e.Kind)
	}
	if e.Status != "failing" || e.FailureStreak != 1 {
		t.Errorf("status=%q streak=%d, want failing/1", e.Status, e.FailureStreak)
	}
	if e.Schedule != "" {
		t.Errorf("schedule = %q, want empty for one-shot job", e.Schedule)
	}
}

// TestQueryJobsAgainstFakeDatasource exercises the full handler path (query
// building + parsing) against a fake Prometheus datasource server, and checks
// the namespace scope is applied to the emitted queries.
func TestQueryJobsAgainstFakeDatasource(t *testing.T) {
	var sawScopedQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("query")
		if strings.Contains(query, `namespace="team-a"`) {
			sawScopedQuery = true
		}
		var result []queries.PromResult
		switch {
		case strings.HasPrefix(query, "kube_cronjob_info"):
			result = []queries.PromResult{pvSchedule(map[string]string{
				ksmLabelCluster: "dev", ksmLabelNamespace: "team-a", ksmLabelCronjob: "nightly",
			}, "0 0 * * *")}
		case strings.HasPrefix(query, "kube_job_owner"):
			result = []queries.PromResult{pv(map[string]string{
				ksmLabelCluster: "dev", ksmLabelNamespace: "team-a", ksmLabelJobName: "nightly-1",
				ksmLabelOwnerKind: ownerKindCronJob, ksmLabelOwnerName: "nightly",
			}, "1")}
		case strings.HasPrefix(query, "kube_job_status_succeeded"):
			result = []queries.PromResult{pv(map[string]string{
				ksmLabelCluster: "dev", ksmLabelNamespace: "team-a", ksmLabelJobName: "nightly-1",
			}, "1")}
		case strings.HasPrefix(query, "kube_job_status_start_time"):
			result = []queries.PromResult{pv(map[string]string{
				ksmLabelCluster: "dev", ksmLabelNamespace: "team-a", ksmLabelJobName: "nightly-1",
			}, "1000")}
		case strings.HasPrefix(query, "kube_job_status_completion_time"):
			result = []queries.PromResult{pv(map[string]string{
				ksmLabelCluster: "dev", ksmLabelNamespace: "team-a", ksmLabelJobName: "nightly-1",
			}, "1042")}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(queries.PromResponse{
			Status: "success",
			Data:   queries.PromData{ResultType: "vector", Result: result},
		})
	}))
	t.Cleanup(srv.Close)

	app := &App{otelCfg: otelconfig.Default()}
	app.promClient = queries.NewPrometheusClient(srv.URL, "")

	resp := app.queryJobs(context.Background(), "team-a", time.Unix(2000, 0))
	if !sawScopedQuery {
		t.Errorf("expected the namespace scope to be applied to KSM queries")
	}
	e := findJob(resp.Jobs, "nightly")
	if e == nil {
		t.Fatal("nightly entry missing")
	}
	if e.Status != "ok" || e.LastRun == nil || e.LastRun.DurationSec != 42 {
		t.Errorf("nightly = %+v (lastRun %+v), want ok / 42s duration", e, e.LastRun)
	}
}
