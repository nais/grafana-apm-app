package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/fingerprint"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// maxPatterns caps the number of error patterns returned — the panel is a
// triage aid, not an exhaustive list, and busy services surface hundreds of
// low-count long-tail patterns that only add noise.
const maxPatterns = 20

// patternSampleLimit is the newest-N error lines fetched for the sampled
// fallback when Loki's pattern ingester is unavailable.
const patternSampleLimit = 1000

// dsUIDPattern matches Grafana datasource UIDs. lokiUid/tracesUid arrive as
// user-controlled query params that we interpolate into a proxy URL path, so
// they are restricted to the Grafana UID charset before use.
var dsUIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

// sanitizeDatasourceUID returns the UID if it matches the Grafana UID charset,
// otherwise "". Callers treat "" as "not configured / invalid".
func sanitizeDatasourceUID(s string) string {
	if dsUIDPattern.MatchString(s) {
		return s
	}
	return ""
}

// literalTokenPattern extracts stable word tokens (letters/digits, ≥4 runes)
// from a pattern string. Loki's placeholders (`<_>`) and punctuation runs are
// excluded by construction, so the longest match is a good free-text search
// literal for filtering the log panel.
var literalTokenPattern = regexp.MustCompile(`[\p{L}\p{N}]{4,}`)

// longestLiteral returns the longest stable word token (≥4 runes) in s, used
// as the click-to-search literal for a pattern. Returns "" when none qualify.
func longestLiteral(s string) string {
	best := ""
	bestLen := 0
	for _, m := range literalTokenPattern.FindAllString(s, -1) {
		if n := utf8.RuneCountInString(m); n > bestLen {
			best, bestLen = m, n
		}
	}
	return best
}

// LogPattern is one clustered error-log pattern with occurrence stats.
type LogPattern struct {
	// Pattern is the clustered template (server mode: Loki's `<_>` pattern;
	// sampled mode: the normalized message title).
	Pattern string `json:"pattern"`
	Level   string `json:"level"`
	// Count is the summed occurrences over the window.
	Count int64 `json:"count"`
	// Sample is a representative raw line (sampled mode only; empty for server
	// mode, where Loki returns no exemplar line).
	Sample      string `json:"sample"`
	FirstSeenMs int64  `json:"firstSeenMs"`
	LastSeenMs  int64  `json:"lastSeenMs"`
	// IsNew is set when the pattern did not appear in the preceding equal-length
	// window (server mode only).
	IsNew bool `json:"isNew"`
	// FilterLiteral is the longest stable token, used to seed the log search.
	FilterLiteral string `json:"filterLiteral"`
}

// LogPatternsResponse is the /logs/patterns payload. Mode records how the
// patterns were produced so the UI can label its provenance.
type LogPatternsResponse struct {
	// Mode is one of: serverPatterns, sampled, unavailable.
	Mode     string       `json:"mode"`
	Patterns []LogPattern `json:"patterns"`
	Note     string       `json:"note,omitempty"`
}

// handleLogPatterns returns the top error-log patterns for a service.
// GET /services/{namespace}/{service}/logs/patterns?from=&to=&lokiUid=
func (a *App) handleLogPatterns(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	_, service := parseServiceRef(req)
	if !requireServiceParam(w, service) {
		return
	}
	from, to := parseTimeRange(req)
	lokiUID := sanitizeDatasourceUID(req.URL.Query().Get("lokiUid"))
	if lokiUID == "" {
		writeJSON(w, LogPatternsResponse{Mode: "unavailable", Patterns: []LogPattern{}, Note: "logs datasource not configured"})
		return
	}

	orgID := req.Header.Get("X-Grafana-Org-Id")
	ck := cacheKey("logpatterns", orgID, roundedUnix(from), roundedUnix(to), service, lokiUID)
	headers := req.Header
	a.writeCached(w, ck, "querying log patterns failed", func() (any, error) {
		return a.queryLogPatterns(ctx, headers, lokiUID, service, from, to), nil
	})
}

// queryLogPatterns tries Loki's pattern ingester first (the accurate,
// fleet-wide clustering) and falls back to sampling+normalizing the newest
// error lines when the ingester or its endpoint is unavailable.
func (a *App) queryLogPatterns(ctx context.Context, headers http.Header, lokiUID, service string, from, to time.Time) LogPatternsResponse {
	logger := log.DefaultLogger.With("handler", "log-patterns")
	selector := fmt.Sprintf(`{%s="%s"}`, a.otelCfg.FaroLoki.ServiceName, service)
	token := a.resolveServiceToken(ctx)

	raw, err := a.fetchLokiPatterns(ctx, headers, token, lokiUID, selector, from, to)
	if err != nil {
		logger.Warn("Pattern ingester unavailable, falling back to sampling", "error", err)
		return a.sampledPatterns(ctx, headers, lokiUID, selector, from, to)
	}

	patterns := serverPatterns(raw)
	if len(patterns) == 0 {
		return LogPatternsResponse{Mode: "serverPatterns", Patterns: []LogPattern{}, Note: "no error log patterns in range"}
	}

	// Second call over the immediately preceding equal-length window flags
	// patterns that only started occurring in the current window.
	span := to.Sub(from)
	if span > 0 {
		if prev, perr := a.fetchLokiPatterns(ctx, headers, token, lokiUID, selector, from.Add(-span), from); perr == nil {
			seen := make(map[string]bool, len(prev))
			for _, p := range prev {
				if strings.EqualFold(p.Level, "error") {
					seen[p.Pattern] = true
				}
			}
			for i := range patterns {
				patterns[i].IsNew = !seen[patterns[i].Pattern]
			}
		}
	}

	return LogPatternsResponse{Mode: "serverPatterns", Patterns: patterns}
}

// lokiPattern is one entry from Loki's /loki/api/v1/patterns response.
type lokiPattern struct {
	Pattern string      `json:"pattern"`
	Level   string      `json:"level"`
	Samples [][]float64 `json:"samples"` // [[unixSec, count], ...]
}

type lokiPatternsResponse struct {
	Status string        `json:"status"`
	Data   []lokiPattern `json:"data"`
}

// fetchLokiPatterns calls Loki's pattern-ingester endpoint through Grafana's
// datasource proxy. The endpoint accepts a BARE stream selector only (pipeline
// stages 400), so level filtering happens client-side in serverPatterns. Auth
// mirrors checkHTTPHealth: service token when configured, else forwarded user
// headers.
func (a *App) fetchLokiPatterns(ctx context.Context, headers http.Header, serviceToken, lokiUID, selector string, from, to time.Time) ([]lokiPattern, error) {
	base := a.proxyURL(lokiUID)
	if base == "" {
		return nil, fmt.Errorf("loki datasource not configured")
	}

	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	q := url.Values{
		"query": {selector},
		"start": {fmt.Sprintf("%d", from.Unix())},
		"end":   {fmt.Sprintf("%d", to.Unix())},
	}
	reqURL := base + "/loki/api/v1/patterns?" + q.Encode()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	applyProxyAuth(httpReq, headers, serviceToken)

	resp, err := a.healthClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close() //nolint:errcheck
	}()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("patterns endpoint returned HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
	if err != nil {
		return nil, err
	}
	var parsed lokiPatternsResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("decoding patterns response: %w", err)
	}
	return parsed.Data, nil
}

// applyProxyAuth attaches datasource-proxy auth to req: the service account
// token when configured (forwarding org id), otherwise the user's session
// headers. Shared by the patterns and trace-analytics proxy/ds-query calls.
func applyProxyAuth(req *http.Request, headers http.Header, serviceToken string) {
	if serviceToken != "" {
		req.Header.Set("Authorization", "Bearer "+serviceToken)
		for _, v := range headers.Values("X-Grafana-Org-Id") {
			req.Header.Add("X-Grafana-Org-Id", v)
		}
		return
	}
	for _, key := range []string{"Cookie", "Authorization", "X-Grafana-Org-Id", "X-Grafana-Id"} {
		for _, v := range headers.Values(key) {
			req.Header.Add(key, v)
		}
	}
}

// serverPatterns filters to error-level patterns, sums their per-bucket sample
// counts, computes first/last-seen from non-empty buckets, sorts by count
// desc, and caps the list.
func serverPatterns(raw []lokiPattern) []LogPattern {
	out := make([]LogPattern, 0, len(raw))
	for _, p := range raw {
		if !strings.EqualFold(p.Level, "error") {
			continue
		}
		var count int64
		var firstMs, lastMs int64
		for _, s := range p.Samples {
			if len(s) < 2 {
				continue
			}
			sec, c := int64(s[0]), int64(s[1])
			if c <= 0 {
				continue
			}
			count += c
			ms := sec * 1000
			if firstMs == 0 || ms < firstMs {
				firstMs = ms
			}
			if ms > lastMs {
				lastMs = ms
			}
		}
		if count == 0 {
			continue
		}
		out = append(out, LogPattern{
			Pattern:       p.Pattern,
			Level:         "error",
			Count:         count,
			FirstSeenMs:   firstMs,
			LastSeenMs:    lastMs,
			FilterLiteral: longestLiteral(p.Pattern),
		})
	}
	return sortAndCapPatterns(out)
}

// sampledPatterns is the fallback when the pattern ingester is unavailable: it
// fetches the newest error lines and clusters them by the same normalization
// used for issue fingerprinting, so one logical error maps to one row.
func (a *App) sampledPatterns(ctx context.Context, headers http.Header, lokiUID, selector string, from, to time.Time) LogPatternsResponse {
	logger := log.DefaultLogger.With("handler", "log-patterns")
	ds := queries.NewDsQueryClient(a.grafanaURL, a.resolveServiceToken(ctx)).WithAuthHeaders(headers)

	// Filter to error lines and reduce each JSON line to its message, matching
	// the LogsTab log panel's line_format, before normalizing.
	expr := selector + " | json | level=~\"(?i)(error|severe|fatal)\"" +
		" | line_format `{{ if .message }}{{ .message }}{{ else if .msg }}{{ .msg }}{{ else }}{{ __line__ }}{{ end }}`"

	entries, err := ds.LogQuery(ctx, lokiUID, expr, from, to, patternSampleLimit)
	if err != nil {
		logger.Warn("Sampled pattern fallback failed", "error", err)
		return LogPatternsResponse{Mode: "unavailable", Patterns: []LogPattern{}, Note: "log pattern ingester and sampling both unavailable"}
	}
	if len(entries) == 0 {
		return LogPatternsResponse{Mode: "sampled", Patterns: []LogPattern{}, Note: "no error lines sampled in range"}
	}

	clusters := make(map[string]*LogPattern)
	for _, e := range entries {
		title := fingerprint.Normalize(e.Line)
		if title == "" {
			continue
		}
		c, ok := clusters[title]
		if !ok {
			c = &LogPattern{Pattern: title, Level: "error", Sample: e.Line, FilterLiteral: longestLiteral(title)}
			clusters[title] = c
		}
		c.Count++
		if c.FirstSeenMs == 0 || e.TimeMs < c.FirstSeenMs {
			c.FirstSeenMs = e.TimeMs
		}
		if e.TimeMs > c.LastSeenMs {
			c.LastSeenMs = e.TimeMs
		}
	}

	patterns := make([]LogPattern, 0, len(clusters))
	for _, c := range clusters {
		patterns = append(patterns, *c)
	}
	return LogPatternsResponse{Mode: "sampled", Patterns: sortAndCapPatterns(patterns), Note: "sampled from newest 1000 error lines"}
}

// sortAndCapPatterns sorts patterns by count desc (pattern text as tiebreak
// for stable output) and truncates to maxPatterns.
func sortAndCapPatterns(patterns []LogPattern) []LogPattern {
	sort.Slice(patterns, func(i, j int) bool {
		if patterns[i].Count != patterns[j].Count {
			return patterns[i].Count > patterns[j].Count
		}
		return patterns[i].Pattern < patterns[j].Pattern
	})
	if len(patterns) > maxPatterns {
		patterns = patterns[:maxPatterns]
	}
	return patterns
}
