package plugin

// Alert rule templates (#65 Phase 1).
//
// GET /alert-templates/{kind}?namespace=&service=&environment=&fingerprint=&hash=
// renders a RuleFormValues-shaped `defaults` object plus a ready-to-navigate
// Grafana URL (`/alerting/new?defaults=<urlencoded JSON>`). The frontend only
// appends `&returnTo=<current plugin URL>` and navigates — every query shape,
// detected metric name, and datasource UID stays server-side so a Grafana
// `defaults=` contract change is patchable in one place.
//
// The `defaults` shape mirrors Grafana's internal RuleFormValues (the same
// mechanism Grafana's own "New alert rule from panel" uses, see
// public/app/features/alerting/unified/utils/navigation.ts). It is an
// internal contract, so we encode a conservative partial object — Grafana
// merges it over its own form defaults:
//
//	{
//	  "type": "grafana",
//	  "name": "...",
//	  "condition": "C",
//	  "evaluateFor": "5m",
//	  "queries": [
//	    {refId:"A", datasourceUid:"<ds>", queryType:"", relativeTimeRange:{from:600,to:0}, model:{refId:"A", expr:"..."}},
//	    {refId:"B", datasourceUid:"__expr__", model:{type:"reduce", expression:"A", reducer:"last", ...}},
//	    {refId:"C", datasourceUid:"__expr__", model:{type:"threshold", expression:"B", conditions:[{evaluator:{params:[<threshold>], type:"gt"}, ...}]}}
//	  ],
//	  "annotations": [{key,value}...],
//	  "labels": [{key,value}...]
//	}
//
// The threshold lives in the C expression (Grafana-native), not baked into
// the PromQL/LogQL expr — a filtering comparison in the expr would make the
// rule evaluate to NoData whenever it is healthy.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend/useragent"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

const (
	// pluginBasePath is the stable URL prefix of this app (docs/url-contract.md).
	pluginBasePath = "/a/nais-apm-app"

	// expressionDatasourceUID is Grafana's reserved UID for server-side expressions.
	expressionDatasourceUID = "__expr__"

	errorRateThreshold      = 0.05 // 5% of requests erroring
	exceptionSpikeThreshold = 10.0 // occurrences per 5m window
	lcpP75ThresholdMs       = 2500 // Google CWV "poor" boundary for LCP

	// SLO burn-rate defaults (Google SRE Workbook, "Multiwindow, Multi-Burn-Rate
	// Alerts"). We ship two of the four canonical tiers: the two that page/ticket
	// on a single RED error-ratio SLI without needing recording rules.
	sloDefaultTarget = 0.999 // 99.9% — the panel's default target
	sloMinTarget     = 0.5   // reject absurd targets; keeps budget math finite
	sloMaxTarget     = 0.999999

	// Fast burn (page): 14.4x budget burn over a 1h long / 5m short window pair —
	// exhausts 2% of a 30d budget in 1h. Slow burn (ticket): 6x over 6h / 30m —
	// exhausts 5% in 6h. Long window is thresholded; short window must agree
	// (gate) so the alert resets quickly once the burn stops.
	sloFastBurnFactor  = 14.4
	sloFastLongWindow  = "1h"
	sloFastShortWin    = "5m"
	sloFastEvaluateFor = "2m"
	sloSlowBurnFactor  = 6.0
	sloSlowLongWindow  = "6h"
	sloSlowShortWin    = "30m"
	sloSlowEvaluateFor = "15m"
)

// alertHashPattern restricts exception hashes to alphanumerics so they can be
// embedded in LogQL line filters and regex alternations without escaping.
var alertHashPattern = regexp.MustCompile(`^[a-zA-Z0-9]+$`)

// ruleFormValuesSchema identifies which RuleFormValues shape the `defaults=`
// object must use. Values are ordered by Grafana major.
type ruleFormValuesSchema int

const (
	// ruleFormValuesV1 is the single shape shipped today — the RuleFormValues
	// contract used by Grafana 10, 11 and 12 (the versions this plugin
	// supports). Grafana 8/9 legacy alerting predates this URL contract and is
	// not supported.
	ruleFormValuesV1 ruleFormValuesSchema = iota
)

// selectRuleFormValuesSchema is the SINGLE version-guard point for the
// `defaults=` contract (#77). That contract mirrors Grafana's INTERNAL,
// unversioned RuleFormValues type
// (public/app/features/alerting/unified/types/rule-form.ts), which can be
// reshaped across Grafana majors — and a shape mismatch silently produces a
// blank rule form rather than an error. Every alert template funnels its shape
// decision through here, so when a future Grafana major reshapes RuleFormValues
// the branch lives in exactly one place, pinned by the golden tests in
// alerttemplates_test.go.
//
// grafanaMajor is the already-detected running Grafana major (see
// grafanaMajorVersion). Do NOT add speculative branches: keep returning
// ruleFormValuesV1 until a real incompatible major ships, then add its case
// here together with the alternate builder and a new golden snapshot.
//
//nolint:unparam // Intentionally returns the one shipped shape today; the
// parameter and switch are the forward-looking version-branch seam (#77).
func selectRuleFormValuesSchema(grafanaMajor int) ruleFormValuesSchema {
	switch {
	case grafanaMajor >= 13:
		// Grafana 13+ has not shipped. When it lands, verify the RuleFormValues
		// shape against a fresh "New alert rule from panel" URL and, if it
		// changed, branch here (e.g. `return ruleFormValuesV2`). Until then the
		// v1 shape is still the correct one, so fall through to it.
		return ruleFormValuesV1
	default:
		return ruleFormValuesV1
	}
}

// grafanaMajorVersion reads the running Grafana major from the request context.
// The SDK carries the Grafana version in the User-Agent it stamps on every
// backend call (e.g. "12.4.0"); it is "0.0.0" when unknown, yielding 0 here —
// which the version guard treats as "assume the current supported shape".
func grafanaMajorVersion(ctx context.Context) int {
	version := useragent.FromContext(ctx).GrafanaVersion()
	major, _, _ := strings.Cut(version, ".")
	n, err := strconv.Atoi(major)
	if err != nil {
		return 0
	}
	return n
}

// alertKeyValue mirrors the KVObject entries in Grafana's RuleFormValues
// annotations/labels arrays.
type alertKeyValue struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// alertRelativeTimeRange mirrors Grafana's RelativeTimeRange (seconds before now).
type alertRelativeTimeRange struct {
	From int `json:"from"`
	To   int `json:"to"`
}

// alertQuery mirrors Grafana's AlertQuery.
type alertQuery struct {
	RefID             string                  `json:"refId"`
	QueryType         string                  `json:"queryType"`
	RelativeTimeRange *alertRelativeTimeRange `json:"relativeTimeRange,omitempty"`
	DatasourceUID     string                  `json:"datasourceUid"`
	Model             map[string]any          `json:"model"`
}

// ruleFormDefaults is the partial RuleFormValues we pre-fill. Grafana merges
// it with its own form defaults, so anything omitted (folder, evaluation
// group, contact point) is chosen by the user in Grafana's editor.
type ruleFormDefaults struct {
	Type        string          `json:"type"`
	Name        string          `json:"name"`
	Condition   string          `json:"condition"`
	EvaluateFor string          `json:"evaluateFor"`
	Queries     []alertQuery    `json:"queries"`
	Annotations []alertKeyValue `json:"annotations"`
	Labels      []alertKeyValue `json:"labels"`
}

// alertTemplateResponse is the resource endpoint payload.
type alertTemplateResponse struct {
	// URL is ready to navigate to after appending &returnTo=<encoded url>.
	URL string `json:"url"`
	// Defaults is the decoded object, exposed for debugging/tests.
	Defaults ruleFormDefaults `json:"defaults"`
}

func (a *App) handleAlertTemplate(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}

	q := req.URL.Query()
	namespace := queries.ParseNamespace(q.Get("namespace"))
	service := queries.MustSanitizeLabel(q.Get("service"))
	if !requireServiceParam(w, service) {
		return
	}
	env := parseEnvironment(req)
	fingerprint := queries.MustSanitizeLabel(q.Get("fingerprint"))
	hashes := parseAlertHashes(q.Get("hash"))

	var defaults ruleFormDefaults

	switch req.PathValue("kind") {
	case "error-rate":
		uid := a.settings.MetricsDataSource.Resolve(env).UID
		if uid == "" {
			http.Error(w, `{"error":"metrics datasource not configured"}`, http.StatusServiceUnavailable)
			return
		}
		defaults = a.errorRateDefaults(a.requestContext(req), namespace, service, env, uid)

	case "exception-spike":
		if len(hashes) == 0 {
			http.Error(w, `{"error":"missing or invalid hash"}`, http.StatusBadRequest)
			return
		}
		uid := a.settings.LogsDataSource.Resolve(env).UID
		if uid == "" {
			http.Error(w, `{"error":"logs datasource not configured"}`, http.StatusServiceUnavailable)
			return
		}
		defaults = a.exceptionSpikeDefaults(namespace, service, env, fingerprint, hashes, uid)

	case "web-vitals":
		uid := a.settings.MetricsDataSource.Resolve(env).UID
		if uid == "" {
			http.Error(w, `{"error":"metrics datasource not configured"}`, http.StatusServiceUnavailable)
			return
		}
		defaults = a.webVitalsDefaults(namespace, service, env, uid)

	case "new-exceptions":
		uid := a.settings.LogsDataSource.Resolve(env).UID
		if uid == "" {
			http.Error(w, `{"error":"logs datasource not configured"}`, http.StatusServiceUnavailable)
			return
		}
		defaults = a.newExceptionsDefaults(namespace, service, env, uid)

	case "slo-burn-rate":
		window := q.Get("window")
		if window == "" {
			window = "fast"
		}
		if window != "fast" && window != "slow" {
			http.Error(w, `{"error":"window must be fast or slow"}`, http.StatusBadRequest)
			return
		}
		uid := a.settings.MetricsDataSource.Resolve(env).UID
		if uid == "" {
			http.Error(w, `{"error":"metrics datasource not configured"}`, http.StatusServiceUnavailable)
			return
		}
		defaults = a.sloBurnRateDefaults(a.requestContext(req), namespace, service, env, uid, parseSloTarget(q.Get("slo")), window)

	default:
		http.Error(w, `{"error":"unknown alert template kind"}`, http.StatusNotFound)
		return
	}

	// Version guard (#77): key the emitted RuleFormValues shape to the running
	// Grafana major. Only one shape ships today, so this is the branch point,
	// not yet a branch — see selectRuleFormValuesSchema.
	//
	//nolint:gocritic // Deliberate single-case switch: the version-branch seam
	// where future Grafana majors add their RuleFormValues shape (#77).
	switch selectRuleFormValuesSchema(grafanaMajorVersion(req.Context())) {
	case ruleFormValuesV1:
		// Current shape — `defaults` is already built for it above.
	}

	data, err := json.Marshal(defaults)
	if err != nil {
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	writeJSON(w, alertTemplateResponse{
		URL:      "/alerting/new?defaults=" + url.QueryEscape(string(data)),
		Defaults: defaults,
	})
}

// errorRateDefaults builds a Mimir error-ratio rule using the detected
// spanmetrics calls metric name (never the hardcoded default when a pipeline
// emits e.g. traces_span_metrics_calls_total).
func (a *App) errorRateDefaults(ctx context.Context, namespace, service, env, dsUID string) ruleFormDefaults {
	labels := a.otelCfg.Labels
	calls := a.callsMetric(ctx)

	base := []string{fmt.Sprintf(`%s="%s"`, labels.ServiceName, service)}
	if namespace != "" {
		base = append(base, fmt.Sprintf(`%s="%s"`, labels.ServiceNamespace, namespace))
	}
	if m := envMatcher(labels.DeploymentEnv, env); m != "" {
		base = append(base, m)
	}
	errSel := strings.Join(append(append([]string{}, base...),
		fmt.Sprintf(`%s="%s"`, labels.StatusCode, a.otelCfg.StatusCodes.Error)), ", ")
	allSel := strings.Join(base, ", ")

	expr := fmt.Sprintf(`sum(rate(%s{%s}[5m])) / sum(rate(%s{%s}[5m]))`, calls, errSel, calls, allSel)

	return ruleFormDefaults{
		Type:        "grafana",
		Name:        fmt.Sprintf("Error rate above 5%% – %s%s", service, envSuffix(env)),
		Condition:   "C",
		EvaluateFor: "5m",
		Queries:     append([]alertQuery{dataQuery(dsUID, expr)}, expressionQueries(errorRateThreshold)...),
		Annotations: []alertKeyValue{
			{Key: "summary", Value: fmt.Sprintf("More than 5%% of requests to %s are failing (5m window)", service)},
			{Key: "nais_apm_url", Value: serviceDeepLink(namespace, service, env, "", "", "")},
		},
		Labels: templateLabels(namespace, service),
	}
}

// exceptionSpikeDefaults builds a Loki count_over_time rule for one exception
// hash (line-filtered exactly like the ExceptionDrawer) or a fingerprint
// group's member hashes (regex form).
func (a *App) exceptionSpikeDefaults(namespace, service, env, fingerprint string, hashes []string, dsUID string) ruleFormDefaults {
	fl := a.otelCfg.FaroLoki

	sel := []string{
		fmt.Sprintf(`%s="%s"`, fl.ServiceName, service),
		fmt.Sprintf(`%s="%s"`, fl.Kind, fl.KindException),
	}
	if m := envMatcher(a.otelCfg.Labels.DeploymentEnv, env); m != "" {
		sel = append(sel, m)
	}
	stream := "{" + strings.Join(sel, ", ") + "}"

	// Line prefilters let Loki skip logfmt-parsing lines for other hashes —
	// same query shapes as the ExceptionDrawer occurrence fetch.
	var lineFilter, fieldFilter string
	if len(hashes) == 1 {
		lineFilter = fmt.Sprintf("|= `%s=%s`", fl.Hash, hashes[0])
		fieldFilter = fmt.Sprintf(`%s="%s"`, fl.Hash, hashes[0])
	} else {
		alt := strings.Join(hashes, "|")
		lineFilter = fmt.Sprintf("|~ `%s=(%s)`", fl.Hash, alt)
		fieldFilter = fmt.Sprintf(`%s=~"(%s)"`, fl.Hash, alt)
	}
	expr := fmt.Sprintf(`sum(count_over_time(%s %s | logfmt | %s [5m]))`, stream, lineFilter, fieldFilter)

	issueRef := fingerprint
	if issueRef == "" {
		issueRef = hashes[0]
	}

	return ruleFormDefaults{
		Type:        "grafana",
		Name:        fmt.Sprintf("Exception spike – %s (%s)", service, shortRef(issueRef)),
		Condition:   "C",
		EvaluateFor: "5m",
		Queries:     append([]alertQuery{dataQuery(dsUID, expr)}, expressionQueries(exceptionSpikeThreshold)...),
		Annotations: []alertKeyValue{
			{Key: "summary", Value: fmt.Sprintf("Frontend exception %s in %s occurred more than %d times in 5m", shortRef(issueRef), service, int(exceptionSpikeThreshold))},
			// Deep link opens the ExceptionDrawer on the Issues tab (#69 P10,
			// docs/url-contract.md): issueId for fingerprint groups (#62),
			// exceptionHash as legacy fallback — both resolve there too.
			{Key: "nais_apm_url", Value: serviceDeepLink(namespace, service, env, "issues", fingerprint, hashes[0])},
		},
		Labels: templateLabels(namespace, service),
	}
}

// webVitalsDefaults builds a Mimir LCP p75 rule over the Alloy-exported Faro
// Web Vitals histogram (Google CWV "poor" boundary).
func (a *App) webVitalsDefaults(namespace, service, env, dsUID string) ruleFormDefaults {
	h := a.otelCfg.AlloyHistogramMetrics
	metric := h.LCP + "_bucket"

	sel := []string{fmt.Sprintf(`%s="%s"`, h.AppLabel, service)}
	if m := envMatcher(h.EnvLabel, env); m != "" {
		sel = append(sel, m)
	}
	expr := fmt.Sprintf(`histogram_quantile(0.75, sum by (%s) (rate(%s{%s}[15m])))`,
		a.otelCfg.Labels.Le, metric, strings.Join(sel, ", "))

	return ruleFormDefaults{
		Type:        "grafana",
		Name:        fmt.Sprintf("LCP p75 above 2.5s – %s%s", service, envSuffix(env)),
		Condition:   "C",
		EvaluateFor: "5m",
		Queries:     append([]alertQuery{dataQuery(dsUID, expr)}, expressionQueries(lcpP75ThresholdMs)...),
		Annotations: []alertKeyValue{
			{Key: "summary", Value: fmt.Sprintf("Largest Contentful Paint p75 for %s is above %dms (Core Web Vitals \"poor\")", service, lcpP75ThresholdMs)},
			// A UX-health alert, not an issue — stays on the Frontend tab (#69 P10).
			{Key: "nais_apm_url", Value: serviceDeepLink(namespace, service, env, "frontend", "", "")},
		},
		Labels: templateLabels(namespace, service),
	}
}

// newExceptionsDefaults builds the #65 Phase 2a "first seen" approximation:
// one alert instance per exception hash present in the last 30m but absent
// from the preceding 7 days. This is stateless and therefore APPROXIMATE —
// the trade-offs are stated in the alert's own summary annotation:
//   - a hash last seen just beyond the lookback re-fires as "new"
//   - Loki retention shorter than 7d silently shrinks the baseline
//   - resolved-issue regressions do NOT fire (no notion of triage state);
//     exact detection is the #57 Phase 2 backend worker
//
// Cost, measured against the chattiest NAV Faro app (tms-min-side,
// >150k exception lines/day): ~11s per evaluation — acceptable at the 5m
// evaluation interval this template ships with.
func (a *App) newExceptionsDefaults(namespace, service, env, dsUID string) ruleFormDefaults {
	fl := a.otelCfg.FaroLoki

	sel := []string{
		fmt.Sprintf(`%s="%s"`, fl.ServiceName, service),
		fmt.Sprintf(`%s="%s"`, fl.Kind, fl.KindException),
	}
	if m := envMatcher(a.otelCfg.Labels.DeploymentEnv, env); m != "" {
		sel = append(sel, m)
	}
	stream := "{" + strings.Join(sel, ", ") + "}"

	expr := fmt.Sprintf(
		`sum by (%[1]s, value) (count_over_time(%[2]s | logfmt | %[1]s!="" | keep %[1]s, value [30m]))
unless on (%[1]s)
sum by (%[1]s) (count_over_time(%[2]s | logfmt | %[1]s!="" | keep %[1]s [7d] offset 30m))`,
		fl.Hash, stream,
	)

	return ruleFormDefaults{
		Type:        "grafana",
		Name:        fmt.Sprintf("New exception types – %s%s", service, envSuffix(env)),
		Condition:   "C",
		EvaluateFor: "5m",
		Queries:     append([]alertQuery{dataQuery(dsUID, expr)}, expressionQueries(0)...),
		Annotations: []alertKeyValue{
			{Key: "summary", Value: fmt.Sprintf(
				"Exception {{ $labels.value }} in %s was not seen in the previous 7 days (approximate stateless detection: "+
					"issues older than the 7d lookback re-fire as new, and resolved-issue regressions do not fire)", service)},
			// Templated per-instance deep link: each firing hash opens its
			// own drawer on the Issues tab (#69 P10, docs/url-contract.md).
			{Key: "nais_apm_url", Value: serviceDeepLink(namespace, service, env, "issues", "", "{{ $labels."+fl.Hash+" }}")},
		},
		Labels: templateLabels(namespace, service),
	}
}

// sloBurnRateDefaults builds one Google-SRE multi-window multi-burn-rate rule
// on the RED error ratio from span metrics. `window` selects the tier:
//   - "fast": 14.4x burn over a 1h(long)/5m(short) window pair → page
//   - "slow": 6x burn over 6h(long)/30m(short) → ticket
//
// The query A value is the LONG-window burn rate (error ratio ÷ error budget,
// so it reads as a multiple of the budget), multiplied by a 0/1 gate that is 1
// only while the SHORT window also exceeds the same factor. Query C thresholds
// that value at the burn factor. So the rule fires iff BOTH windows exceed the
// factor — the multiwindow condition — while still returning a plain number (0
// when healthy, never NoData for a service with traffic), keeping the primary
// threshold in Grafana's C expression as the other templates do.
//
// The SLO target parameterises only the error-budget divisor (1-target); the
// factor lives in both the gate and the C threshold. `or vector(0)` on each
// error numerator makes a zero-error window read as 0 burn instead of an empty
// result (verified against live span metrics — a healthy busy service returns
// exactly 0, a burning one returns its long-window multiple).
func (a *App) sloBurnRateDefaults(ctx context.Context, namespace, service, env, dsUID string, slo float64, window string) ruleFormDefaults {
	labels := a.otelCfg.Labels
	calls := a.callsMetric(ctx)

	base := []string{fmt.Sprintf(`%s="%s"`, labels.ServiceName, service)}
	if namespace != "" {
		base = append(base, fmt.Sprintf(`%s="%s"`, labels.ServiceNamespace, namespace))
	}
	if m := envMatcher(labels.DeploymentEnv, env); m != "" {
		base = append(base, m)
	}
	errSel := strings.Join(append(append([]string{}, base...),
		fmt.Sprintf(`%s="%s"`, labels.StatusCode, a.otelCfg.StatusCodes.Error)), ", ")
	allSel := strings.Join(base, ", ")

	factor, longWin, shortWin, evalFor, tier := sloSlowBurnFactor, sloSlowLongWindow, sloSlowShortWin, sloSlowEvaluateFor, "Slow"
	if window == "fast" {
		factor, longWin, shortWin, evalFor, tier = sloFastBurnFactor, sloFastLongWindow, sloFastShortWin, sloFastEvaluateFor, "Fast"
	}

	budget := formatBudget(slo)
	factorStr := strconv.FormatFloat(factor, 'g', -1, 64)

	longBurn := fmt.Sprintf(`%s / %s`, sloRatioExpr(calls, errSel, allSel, longWin), budget)
	shortBurn := fmt.Sprintf(`%s / %s`, sloRatioExpr(calls, errSel, allSel, shortWin), budget)
	expr := fmt.Sprintf(`%s * (%s >= bool %s)`, longBurn, shortBurn, factorStr)

	sloPct := formatSloPct(slo)

	return ruleFormDefaults{
		Type:        "grafana",
		Name:        fmt.Sprintf("%s burn (%sx) – SLO %s – %s%s", tier, factorStr, sloPct, service, envSuffix(env)),
		Condition:   "C",
		EvaluateFor: evalFor,
		Queries:     append([]alertQuery{dataQuery(dsUID, expr)}, expressionQueries(factor)...),
		Annotations: []alertKeyValue{
			{Key: "summary", Value: fmt.Sprintf(
				"%s error budget burn on %s: the %s error ratio is above %sx the %s SLO budget (confirmed over %s)",
				strings.ToLower(tier), service, longWin, factorStr, sloPct, shortWin)},
			{Key: "nais_apm_url", Value: serviceDeepLink(namespace, service, env, "", "", "")},
		},
		Labels: append(templateLabels(namespace, service),
			alertKeyValue{Key: "severity", Value: sloSeverity(window)},
			alertKeyValue{Key: "slo", Value: sloPct},
		),
	}
}

// sloRatioExpr renders `(sum(rate(err[w])) or vector(0)) / sum(rate(all[w]))`.
// The `or vector(0)` makes a zero-error window a real 0 rather than an empty
// vector (which would otherwise collapse the whole burn expression to NoData).
func sloRatioExpr(calls, errSel, allSel, window string) string {
	return fmt.Sprintf(`(sum(rate(%s{%s}[%s])) or vector(0)) / sum(rate(%s{%s}[%s]))`,
		calls, errSel, window, calls, allSel, window)
}

// parseSloTarget parses the `slo` query param (a fraction like 0.999),
// clamping to a sane range and falling back to the 99.9% default.
func parseSloTarget(raw string) float64 {
	if raw == "" {
		return sloDefaultTarget
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || v < sloMinTarget || v > sloMaxTarget {
		return sloDefaultTarget
	}
	return v
}

// formatBudget renders the error budget (1 - target) as a clean decimal string,
// rounding away float subtraction noise (1-0.999 → "0.001", not
// "0.0010000000000000009").
func formatBudget(slo float64) string {
	budget := math.Round((1-slo)*1e9) / 1e9
	return strconv.FormatFloat(budget, 'g', -1, 64)
}

// formatSloPct renders the target as a percentage for names/labels ("99.9%").
func formatSloPct(slo float64) string {
	pct := math.Round(slo*1e7) / 1e5
	return strconv.FormatFloat(pct, 'g', -1, 64) + "%"
}

// sloSeverity maps the burn tier to a routing severity label.
func sloSeverity(window string) string {
	if window == "fast" {
		return "critical"
	}
	return "warning"
}

// dataQuery builds the refId A data query against a real datasource.
func dataQuery(dsUID, expr string) alertQuery {
	return alertQuery{
		RefID:             "A",
		QueryType:         "",
		RelativeTimeRange: &alertRelativeTimeRange{From: 600, To: 0},
		DatasourceUID:     dsUID,
		Model: map[string]any{
			"refId": "A",
			"expr":  expr,
		},
	}
}

// expressionQueries builds the reduce (B) + threshold (C) expression pair,
// mirroring Grafana's getDefaultExpressions used by "New alert rule from panel".
func expressionQueries(threshold float64) []alertQuery {
	exprDS := map[string]any{"type": expressionDatasourceUID, "uid": expressionDatasourceUID}
	return []alertQuery{
		{
			RefID:         "B",
			QueryType:     "",
			DatasourceUID: expressionDatasourceUID,
			Model: map[string]any{
				"refId":      "B",
				"type":       "reduce",
				"datasource": exprDS,
				"expression": "A",
				"reducer":    "last",
			},
		},
		{
			RefID:         "C",
			QueryType:     "",
			DatasourceUID: expressionDatasourceUID,
			Model: map[string]any{
				"refId":      "C",
				"type":       "threshold",
				"datasource": exprDS,
				"expression": "B",
				"conditions": []map[string]any{
					{
						"type":      "query",
						"evaluator": map[string]any{"params": []float64{threshold}, "type": "gt"},
						"operator":  map[string]any{"type": "and"},
						"query":     map[string]any{"params": []string{"C"}},
						"reducer":   map[string]any{"params": []string{}, "type": "last"},
					},
				},
			},
		},
	}
}

// templateLabels are attached to every created rule so teams can route and
// audit plugin-suggested rules (`source=nais-apm`).
func templateLabels(namespace, service string) []alertKeyValue {
	labels := make([]alertKeyValue, 0, 3)
	if namespace != "" {
		labels = append(labels, alertKeyValue{Key: "namespace", Value: namespace})
	}
	labels = append(labels,
		alertKeyValue{Key: "service", Value: service},
		alertKeyValue{Key: "source", Value: "nais-apm"},
	)
	return labels
}

// serviceDeepLink builds the stable plugin URL for alert annotations
// (docs/url-contract.md). fingerprint wins over hash when both are set.
func serviceDeepLink(namespace, service, env, tab, fingerprint, hash string) string {
	ns := namespace
	if ns == "" {
		ns = "_"
	}
	link := fmt.Sprintf("%s/services/%s/%s", pluginBasePath, url.PathEscape(ns), url.PathEscape(service))

	params := url.Values{}
	if tab != "" {
		params.Set("tab", tab)
	}
	if env != "" {
		params.Set("environment", env)
	}
	if fingerprint != "" {
		params.Set("issueId", fingerprint)
	} else if hash != "" {
		params.Set("exceptionHash", hash)
	}
	if enc := params.Encode(); enc != "" {
		link += "?" + enc
	}
	return link
}

// parseAlertHashes splits a comma-separated hash list, dropping anything that
// is not purely alphanumeric (hashes are hex; this also makes them safe in
// LogQL regex alternations without escaping).
func parseAlertHashes(raw string) []string {
	if raw == "" {
		return nil
	}
	var hashes []string
	for _, part := range strings.Split(raw, ",") {
		h := strings.TrimSpace(part)
		if h != "" && alertHashPattern.MatchString(h) {
			hashes = append(hashes, h)
		}
	}
	return hashes
}

// envSuffix renders " (env)" for rule names, or "" when no environment filter.
func envSuffix(env string) string {
	if env == "" {
		return ""
	}
	return fmt.Sprintf(" (%s)", env)
}

// shortRef truncates long fingerprints/hashes for rule names and summaries.
func shortRef(ref string) string {
	const maxLen = 20
	if len(ref) <= maxLen {
		return ref
	}
	return ref[:maxLen] + "…"
}
