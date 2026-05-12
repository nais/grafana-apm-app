package plugin

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// handleConnectedServices returns inbound and outbound service connections.
// GET /services/{namespace}/{service}/connected?from=&to=&environment=
func (a *App) handleConnectedServices(w http.ResponseWriter, req *http.Request) {
	if !requireGET(w, req) {
		return
	}
	ctx := a.requestContext(req)
	_, service := parseServiceRef(req)
	filterEnv := parseEnvironment(req)

	if !requireServiceParam(w, service) {
		return
	}

	caps := a.cachedOrDetectCapabilities(ctx)
	if !caps.ServiceGraph.Detected {
		writeJSON(w, ConnectedServicesResponse{
			Inbound:  []ConnectedService{},
			Outbound: []ConnectedService{},
		})
		return
	}

	now := time.Now()
	from := parseUnixParam(req, "from", now.Add(-1*time.Hour))
	to := parseUnixParam(req, "to", now)

	resp := a.queryConnectedServices(ctx, from, to, service, filterEnv)
	writeJSON(w, resp)
}

func (a *App) queryConnectedServices(ctx context.Context, from, to time.Time, service, filterEnvironment string) ConnectedServicesResponse {
	logger := log.DefaultLogger.With("handler", "connected-services")
	rangeStr := computeRangeStr(from, to)
	sgp := a.serviceGraphPrefix()
	cfg := a.otelCfg

	envLabelFilter := ""
	if m := envMatcher(cfg.Labels.DeploymentEnv, filterEnvironment); m != "" {
		envLabelFilter = ", " + m
	}

	// Outbound: where service is the client
	outRateQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s%s{%s="%s"%s}%s))`,
		cfg.Labels.Server, cfg.Labels.ConnectionType,
		sgp, cfg.ServiceGraph.RequestTotal,
		cfg.Labels.Client, service, envLabelFilter, rangeStr,
	)
	outErrQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s%s{%s="%s"%s}%s))`,
		cfg.Labels.Server, cfg.Labels.ConnectionType,
		sgp, cfg.ServiceGraph.RequestFailedTotal,
		cfg.Labels.Client, service, envLabelFilter, rangeStr,
	)
	outP95Q := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s, %s) (rate(%s%s{%s="%s"%s}%s)))`,
		cfg.Labels.Server, cfg.Labels.ConnectionType, cfg.Labels.Le,
		sgp, cfg.ServiceGraph.RequestServerBucket,
		cfg.Labels.Client, service, envLabelFilter, rangeStr,
	)

	// Inbound: where service is the server (service graph)
	inRateQ := fmt.Sprintf(
		`sum by (%s) (rate(%s%s{%s="%s"%s}%s))`,
		cfg.Labels.Client,
		sgp, cfg.ServiceGraph.RequestTotal,
		cfg.Labels.Server, service, envLabelFilter, rangeStr,
	)
	inErrQ := fmt.Sprintf(
		`sum by (%s) (rate(%s%s{%s="%s"%s}%s))`,
		cfg.Labels.Client,
		sgp, cfg.ServiceGraph.RequestFailedTotal,
		cfg.Labels.Server, service, envLabelFilter, rangeStr,
	)
	inP95Q := fmt.Sprintf(
		`histogram_quantile(0.95, sum by (%s, %s) (rate(%s%s{%s="%s"%s}%s)))`,
		cfg.Labels.Client, cfg.Labels.Le,
		sgp, cfg.ServiceGraph.RequestServerBucket,
		cfg.Labels.Server, service, envLabelFilter, rangeStr,
	)

	// Spanmetrics supplement: find upstream callers via CLIENT spans whose
	// server_address or http_host matches this service name.
	// Pattern: server_address=~"appname[.:].*" catches both
	// "appname.namespace.svc" and "appname:8080" style addresses.
	escapedSvc := promQLEscape(service)
	smInRateQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s[.:].*"%s}%s)) or sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s[.:].*"%s}%s))`,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.ServerAddress, escapedSvc, envLabelFilter, rangeStr,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.HTTPHost, escapedSvc, envLabelFilter, rangeStr,
	)
	smInErrQ := fmt.Sprintf(
		`sum by (%s, %s) (rate(%s{%s="%s", %s="%s", %s=~"%s[.:].*"%s}%s)) or sum by (%s, %s) (rate(%s{%s="%s", %s="%s", %s=~"%s[.:].*"%s}%s))`,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.StatusCode, cfg.StatusCodes.Error,
		cfg.Labels.ServerAddress, escapedSvc, envLabelFilter, rangeStr,
		cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.StatusCode, cfg.StatusCodes.Error,
		cfg.Labels.HTTPHost, escapedSvc, envLabelFilter, rangeStr,
	)

	// Ingress alias supplement: find callers via ingress hostnames configured
	// as aliases for this service (e.g., on-prem callers using nais ingress).
	for _, hostname := range a.ingressHostnames(service) {
		escapedHost := promQLEscape(hostname)
		smInRateQ += fmt.Sprintf(
			` or sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s(:[0-9]+)?"%s}%s))`,
			cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
			a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
			cfg.Labels.ServerAddress, escapedHost, envLabelFilter, rangeStr,
		)
		smInRateQ += fmt.Sprintf(
			` or sum by (%s, %s) (rate(%s{%s="%s", %s=~"%s(:[0-9]+)?"%s}%s))`,
			cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
			a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
			cfg.Labels.HTTPHost, escapedHost, envLabelFilter, rangeStr,
		)
		smInErrQ += fmt.Sprintf(
			` or sum by (%s, %s) (rate(%s{%s="%s", %s="%s", %s=~"%s(:[0-9]+)?"%s}%s))`,
			cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
			a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
			cfg.Labels.StatusCode, cfg.StatusCodes.Error,
			cfg.Labels.ServerAddress, escapedHost, envLabelFilter, rangeStr,
		)
		smInErrQ += fmt.Sprintf(
			` or sum by (%s, %s) (rate(%s{%s="%s", %s="%s", %s=~"%s(:[0-9]+)?"%s}%s))`,
			cfg.Labels.ServiceName, cfg.Labels.ServiceNamespace,
			a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
			cfg.Labels.StatusCode, cfg.StatusCodes.Error,
			cfg.Labels.HTTPHost, escapedHost, envLabelFilter, rangeStr,
		)
	}

	// Outbound spanmetrics supplement: discover external targets not in the
	// service graph (e.g., Azure AD, APIs in other clusters). The service
	// graph only generates edges when both client + server report to the same
	// Tempo instance.
	smOutRateQ := fmt.Sprintf(
		`sum by (%s, %s, %s) (rate(%s{%s="%s", %s="%s", %s!=""%s}%s))`,
		cfg.Labels.ServerAddress, cfg.Labels.DBSystem, cfg.Labels.MessagingSystem,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.ServiceName, service, cfg.Labels.ServerAddress, envLabelFilter, rangeStr,
	)
	smOutErrQ := fmt.Sprintf(
		`sum by (%s) (rate(%s{%s="%s", %s="%s", %s="%s", %s!=""%s}%s))`,
		cfg.Labels.ServerAddress,
		a.callsMetric(ctx), cfg.Labels.SpanKind, cfg.SpanKinds.Client,
		cfg.Labels.ServiceName, service,
		cfg.Labels.StatusCode, cfg.StatusCodes.Error, cfg.Labels.ServerAddress, envLabelFilter, rangeStr,
	)

	jobs := []QueryJob{
		{"outRate", outRateQ}, {"outErr", outErrQ}, {"outP95", outP95Q},
		{"inRate", inRateQ}, {"inErr", inErrQ}, {"inP95", inP95Q},
		{"smInRate", smInRateQ}, {"smInErr", smInErrQ},
		{"smOutRate", smOutRateQ}, {"smOutErr", smOutErrQ},
	}

	resultMap := a.runInstantQueries(ctx, to, jobs, logger)

	buildList := func(rateKey, errKey, p95Key, peerLabel string) []ConnectedService {
		type connKey struct {
			name           string
			connectionType string
		}
		type svcData struct {
			rate float64
			err  float64
			p95  float64
		}
		m := make(map[connKey]*svcData)
		for _, r := range resultMap[rateKey] {
			name := r.Metric[peerLabel]
			if name == "" {
				continue
			}
			k := connKey{name: name, connectionType: r.Metric[cfg.Labels.ConnectionType]}
			d, ok := m[k]
			if !ok {
				d = &svcData{}
				m[k] = d
			}
			d.rate += r.Value.Float()
		}
		for _, r := range resultMap[errKey] {
			name := r.Metric[peerLabel]
			ct := r.Metric[cfg.Labels.ConnectionType]
			k := connKey{name: name, connectionType: ct}
			if d, ok := m[k]; ok {
				d.err += r.Value.Float()
			}
		}
		if p95Key != "" {
			for _, r := range resultMap[p95Key] {
				name := r.Metric[peerLabel]
				ct := r.Metric[cfg.Labels.ConnectionType]
				k := connKey{name: name, connectionType: ct}
				if d, ok := m[k]; ok {
					v := r.Value.Float()
					if isValidMetricValue(v) {
						d.p95 = v
					}
				}
			}
		}
		result := make([]ConnectedService, 0, len(m))
		for k, d := range m {
			result = append(result, ConnectedService{
				Name:           k.name,
				ConnectionType: k.connectionType,
				IsSidecar:      isSidecar(k.name),
				Rate:           roundTo(d.rate, 3),
				ErrorRate:      calculateErrorRate(d.err, d.rate),
				P95Duration:    roundTo(d.p95*1000, 2),
				DurationUnit:   "ms",
			})
		}
		sort.Slice(result, func(i, j int) bool {
			return result[i].Rate > result[j].Rate
		})
		return result
	}

	outbound := buildList("outRate", "outErr", "outP95", cfg.Labels.Server)
	inbound := buildList("inRate", "inErr", "inP95", cfg.Labels.Client)

	// Merge spanmetrics outbound targets (external services not in service graph)
	smOutbound := buildList("smOutRate", "smOutErr", "", cfg.Labels.ServerAddress)
	outboundNames := make(map[string]bool, len(outbound))
	for _, s := range outbound {
		outboundNames[strings.ToLower(s.Name)] = true
	}
	for i := range smOutbound {
		smOutbound[i].Name = a.resolveIngressAlias(extractTopologyNodeName(smOutbound[i].Name))
		if smOutbound[i].Name == "" || smOutbound[i].Name == service || outboundNames[strings.ToLower(smOutbound[i].Name)] {
			continue // already in service graph results, self-reference, or empty
		}
		outboundNames[strings.ToLower(smOutbound[i].Name)] = true
		outbound = append(outbound, smOutbound[i])
	}
	sort.Slice(outbound, func(i, j int) bool {
		return outbound[i].Rate > outbound[j].Rate
	})

	// Merge spanmetrics inbound callers (discovered via server_address/http_host matching)
	smInbound := buildList("smInRate", "smInErr", "", cfg.Labels.ServiceName)
	inboundNames := make(map[string]bool, len(inbound))
	for _, s := range inbound {
		inboundNames[strings.ToLower(s.Name)] = true
	}
	for _, s := range smInbound {
		if s.Name == service || inboundNames[strings.ToLower(s.Name)] {
			continue // already in service graph results or self-reference
		}
		inbound = append(inbound, s)
	}
	// Re-sort merged inbound by rate
	sort.Slice(inbound, func(i, j int) bool {
		return inbound[i].Rate > inbound[j].Rate
	})

	return ConnectedServicesResponse{Inbound: inbound, Outbound: outbound}
}
