package plugin

import (
	"regexp"
	"strings"
	"testing"
)

func TestClassifyDependency(t *testing.T) {
	tests := []struct {
		name      string
		depName   string
		connType  string
		dbSysMap  map[string]string
		msgSysMap map[string]string
		expected  string
	}{
		// database connection type with db.system enrichment
		{"postgres from db.system", "mydb-host", "database", map[string]string{"mydb-host": "postgresql"}, nil, "postgresql"},
		{"oracle from db.system", "orahost", "database", map[string]string{"orahost": "oracle"}, nil, "oracle"},
		{"redis from db.system", "cache-host", "database", map[string]string{"cache-host": "redis"}, nil, "redis"},
		{"mongodb from db.system", "mongo-host", "database", map[string]string{"mongo-host": "mongodb"}, nil, "mongodb"},

		// database connection type with hostname inference
		{"oracle RAC scan", "dmv04-scan.oera.no", "database", nil, nil, "oracle"},
		{"nav postgres host", "a01dbvl123.oera.no", "database", nil, nil, "postgresql"},
		{"redis in hostname", "my-redis-cluster", "database", nil, nil, "redis"},
		{"valkey in hostname", "test-valkey-01", "database", nil, nil, "redis"},
		{"opensearch in hostname", "logs-opensearch-01", "database", nil, nil, "opensearch"},
		{"unknown db host", "some-random-host", "database", nil, nil, "database"},

		// messaging system — service names are consumers, not dependencies
		{"kafka consumer as service", "veilarbportefolje", "messaging_system", nil, nil, "service"},
		{"kafka consumer service", "vergemaal", "messaging_system", nil, nil, "service"},
		// messaging system — broker hostnames with specific messaging_system label
		{"kafka broker with label", "kafka-brokers.nav.no", "messaging_system", nil, map[string]string{"kafka-brokers.nav.no": "kafka"}, "kafka"},
		{"jms broker with label", "jms-broker.nav.no", "messaging_system", nil, map[string]string{"jms-broker.nav.no": "jms"}, "messaging"},
		{"rabbitmq broker with label", "rmq.example.com", "messaging_system", nil, map[string]string{"rmq.example.com": "rabbitmq"}, "rabbitmq"},
		// messaging system — broker hostnames without label (fallback)
		{"kafka broker hostname", "kafka-brokers.nav.no", "messaging_system", nil, nil, "kafka"},
		{"kafka broker name", "kafka", "messaging_system", nil, nil, "kafka"},
		{"rabbitmq broker name", "rabbitmq", "messaging_system", nil, nil, "kafka"},

		// virtual node
		{"external virtual node", "api.example.com", "virtual_node", nil, nil, "external"},

		// no connection type — db.system map lookup
		{"no conntype postgres", "mydb", "", map[string]string{"mydb": "postgresql"}, nil, "postgresql"},

		// no connection type — name inference
		{"no conntype redis name", "redis", "", nil, nil, "redis"},
		{"no conntype valkey name", "valkey", "", nil, nil, "redis"},
		{"no conntype kafka name", "kafka", "", nil, nil, "kafka"},
		{"no conntype aiven redis", "my-app-redis-01.aivencloud.com", "", nil, nil, "redis"},
		{"no conntype unknown name", "some-service", "", nil, nil, "service"},

		// nil dbSysMap with database type
		{"nil map database", "host.example.com", "database", nil, nil, "database"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyDependency(tc.depName, tc.connType, tc.dbSysMap, tc.msgSysMap)
			if got != tc.expected {
				t.Errorf("classifyDependency(%q, %q, %v, %v) = %q, want %q",
					tc.depName, tc.connType, tc.dbSysMap, tc.msgSysMap, got, tc.expected)
			}
		})
	}
}

func TestNormalizeDBSystem(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"postgresql", "postgresql"},
		{"postgres", "postgresql"},
		{"oracle", "oracle"},
		{"mongodb", "mongodb"},
		{"mongo", "mongodb"},
		{"redis", "redis"},
		{"mysql", "mysql"},
		{"mariadb", "mysql"},
		{"db2", "db2"},
		{"opensearch", "opensearch"},
		{"elasticsearch", "opensearch"},
		{"h2", "h2"},
		{"other_sql", "database"},
		{"some_unknown_db", "database"},
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			got := normalizeDBSystem(tc.input)
			if got != tc.expected {
				t.Errorf("normalizeDBSystem(%q) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestNormalizeMessagingSystem(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"kafka", "kafka"},
		{"Kafka", "kafka"},
		{"rabbitmq", "rabbitmq"},
		{"RabbitMQ", "rabbitmq"},
		{"jms", "messaging"},
		{"JMS", "messaging"},
		{"nats", "messaging"},
		{"unknown_system", "messaging"},
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			got := normalizeMessagingSystem(tc.input)
			if got != tc.expected {
				t.Errorf("normalizeMessagingSystem(%q) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestFormatDepDisplayName(t *testing.T) {
	tests := []struct {
		name            string
		depName         string
		dbSystem        string
		messagingSystem string
		expected        string
	}{
		{"database dep", "100.71.2.33", "postgresql", "", "postgresql (100.71.2.33)"},
		{"oracle dep", "dmv04-scan.oera.no", "oracle", "", "oracle (dmv04-scan.oera.no)"},
		{"postgres alias", "mydb.host", "postgres", "", "postgresql (mydb.host)"},
		{"kafka dep", "kafka-brokers.nav.no", "", "kafka", "kafka (kafka-brokers.nav.no)"},
		{"jms dep", "jms-broker.nav.no", "", "jms", "jms (jms-broker.nav.no)"},
		{"no enrichment", "api.example.com", "", "", ""},
		{"db takes precedence", "host", "redis", "kafka", "redis (host)"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := formatDepDisplayName(tc.depName, tc.dbSystem, tc.messagingSystem)
			if got != tc.expected {
				t.Errorf("formatDepDisplayName(%q, %q, %q) = %q, want %q",
					tc.depName, tc.dbSystem, tc.messagingSystem, got, tc.expected)
			}
		})
	}
}

func TestInferFromName(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"exact redis", "redis", "redis"},
		{"exact valkey", "valkey", "redis"},
		{"exact kafka", "kafka", "kafka"},
		{"redis substring", "my-redis-host", "redis"},
		{"valkey substring", "test-valkey-01", "redis"},
		{"aiven redis", "my-app-redis-01.aivencloud.com", "redis"},
		{"aiven non-redis", "other-thing.aivencloud.com", "redis"},
		{"regular service", "some-service", "service"},
		{"k8s service.namespace", "sokos-kontoregister-person.okonomi", "service"},
		{"k8s service.namespace 2", "digdir-krr-proxy.team-rocket", "service"},
		{"k8s service.namespace 3", "sf-henvendelse-api-proxy.teamnks", "service"},
		{"k8s service.namespace 4", "repr-api.repr", "service"},
		{"k8s service.namespace 5", "spokelse.tbd", "service"},
		{"external 2-part TLD", "idporten.no", "external"},
		{"external 2-part com", "example.com", "external"},
		{"external 3-part", "graph.microsoft.com", "external"},
		{"external nais ingress", "pdl-api.prod-fss-pub.nais.io", "external"},
		{"external nav cloud", "personoversikt-unleash-api.nav.cloud.nais.io", "external"},
		{"case insensitive redis", "REDIS", "redis"},
		{"case insensitive kafka", "Kafka", "kafka"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := inferFromName(tc.input)
			if got != tc.expected {
				t.Errorf("inferFromName(%q) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestNormalizeAddress(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"empty", "", ""},
		{"plain hostname", "graph.microsoft.com", "graph.microsoft.com"},
		{"strip port 443", "login.microsoftonline.com:443", "login.microsoftonline.com"},
		{"strip port 80", "example.com:80", "example.com"},
		{"keep other port", "my-service:8080", "my-service:8080"},
		{"trailing dot", "idporten.no.", "idporten.no"},
		{"trailing dot with port", "api.example.com.:443", "api.example.com"},
		{"uppercase", "Graph.Microsoft.COM", "graph.microsoft.com"},
		{"uppercase with port", "IDPORTEN.NO:443", "idporten.no"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := normalizeAddress(tc.input)
			if got != tc.expected {
				t.Errorf("normalizeAddress(%q) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestRegexQuoteMetaForHostnames(t *testing.T) {
	// Verify that regexp.QuoteMeta properly escapes dots in hostnames
	// to prevent overmatching in PromQL =~ regex matchers.
	// Before the fix, "api.example.com" would match "apiXexampleYcom".
	tests := []struct {
		name     string
		hostname string
		match    string
		noMatch  string
	}{
		{
			name:     "dots are escaped",
			hostname: "api.example.com",
			match:    "api.example.com",
			noMatch:  "apiXexampleYcom",
		},
		{
			name:     "hostname with port suffix pattern",
			hostname: "idporten.no",
			match:    "idporten.no:443",
			noMatch:  "idportenXno:443",
		},
		{
			name:     "simple hostname",
			hostname: "redis-cluster",
			match:    "redis-cluster",
			noMatch:  "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			escaped := regexp.QuoteMeta(tc.hostname)
			pattern := "^" + escaped + "(:443)?$"
			re := regexp.MustCompile(pattern)

			if !re.MatchString(tc.match) {
				t.Errorf("pattern %q should match %q", pattern, tc.match)
			}
			if tc.noMatch != "" && re.MatchString(tc.noMatch) {
				t.Errorf("pattern %q should NOT match %q", pattern, tc.noMatch)
			}
		})
	}
}

func TestCoalesceAddress(t *testing.T) {
	tests := []struct {
		name          string
		serverAddress string
		httpHost      string
		expected      string
	}{
		{"prefer server_address", "api.example.com", "api.example.com:443", "api.example.com"},
		{"fallback to http_host", "", "login.microsoftonline.com:443", "login.microsoftonline.com"},
		{"both empty", "", "", ""},
		{"only server_address", "graph.microsoft.com", "", "graph.microsoft.com"},
		{"server_address with port", "db.example.com:5432", "", "db.example.com:5432"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := coalesceAddress(tc.serverAddress, tc.httpHost)
			if got != tc.expected {
				t.Errorf("coalesceAddress(%q, %q) = %q, want %q",
					tc.serverAddress, tc.httpHost, got, tc.expected)
			}
		})
	}
}

// TestAddressMatchRegexRoundTrip verifies that addressMatchRegex produces a
// pattern that matches both the normalized name and the original raw label value.
func TestAddressMatchRegexRoundTrip(t *testing.T) {
	tests := []struct {
		name      string
		rawLabel  string
		shouldHit []string
		shouldMis []string
	}{
		{
			"443 port stripped",
			"idporten.no:443",
			[]string{"idporten.no", "idporten.no:443", "idporten.no:80"},
			[]string{"idportenXno", "idporten.no:8080"},
		},
		{
			"80 port stripped",
			"api.example.com:80",
			[]string{"api.example.com", "api.example.com:80", "api.example.com:443"},
			[]string{"api.example.com:8080"},
		},
		{
			"non-standard port preserved",
			"db.host:5432",
			[]string{"db.host:5432"},
			[]string{"db.host", "db.host:443"},
		},
		{
			"no port at all",
			"kafka",
			[]string{"kafka", "kafka:443", "kafka:80"},
			[]string{"kafka:9092"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			normalized := normalizeAddress(tc.rawLabel)
			promQLPattern := addressMatchRegex(normalized)
			// addressMatchRegex returns a PromQL-escaped pattern (double backslashes).
			// Simulate PromQL string un-escaping to get a raw regex for Go's regexp.
			goPattern := strings.ReplaceAll(promQLPattern, `\\`, `\`)
			re := regexp.MustCompile("^" + goPattern + "$")
			for _, hit := range tc.shouldHit {
				if !re.MatchString(hit) {
					t.Errorf("addressMatchRegex(%q) pattern %q should match %q", normalized, promQLPattern, hit)
				}
			}
			for _, mis := range tc.shouldMis {
				if re.MatchString(mis) {
					t.Errorf("addressMatchRegex(%q) pattern %q should NOT match %q", normalized, promQLPattern, mis)
				}
			}
		})
	}
}

func TestIsExternalHostname(t *testing.T) {
tests := []struct {
name     string
input    string
external bool
}{
// Internal K8s names
{"bare service", "norg2", false},
{"service.namespace", "sokos-kontoregister-person.okonomi", false},
{"service.namespace 2", "digdir-krr-proxy.team-rocket", false},
{"service with svc suffix", "my-app.ns.svc", false},
{"service with svc.cluster", "my-app.ns.svc.cluster.local", false},
{"port on bare name", "redis:6379", false},
{"port on k8s name", "my-app.ns:8080", false},
// External hostnames
{"2-part with .no TLD", "idporten.no", true},
{"2-part with .com TLD", "example.com", true},
{"2-part with .io TLD", "grafana.io", true},
{"2-part with .org TLD", "norg2.org", true},
{"3-part hostname", "graph.microsoft.com", true},
{"4-part hostname", "pdl-api.prod-fss-pub.nais.io", true},
{"nav cloud", "personoversikt-unleash-api.nav.cloud.nais.io", true},
{"with port 443", "login.microsoftonline.com:443", true},
{"with port 80", "api.example.com:80", true},
}
for _, tc := range tests {
t.Run(tc.name, func(t *testing.T) {
got := isExternalHostname(tc.input)
if got != tc.external {
t.Errorf("isExternalHostname(%q) = %v, want %v", tc.input, got, tc.external)
}
})
}
}

func TestStripHexSuffix(t *testing.T) {
tests := []struct {
name     string
input    string
expected string
}{
{"no suffix", "nav-dekoratoren", "nav-dekoratoren"},
{"short hex 8 chars kept", "my-service-deadbeef", "my-service-deadbeef"},
{"11 hex chars kept", "my-service-deadbeef012", "my-service-deadbeef012"},
{"12 hex chars stripped", "my-service-deadbeef0123", "my-service"},
{"long commit hash", "nav-dekoratoren-28e8c72f0abdc4109d600c", "nav-dekoratoren"},
{"full SHA", "nav-dekoratoren-1c8de8dedcca53c151b678caa0123456789abcde", "nav-dekoratoren"},
{"multiple dashes in base", "tms-min-side-abc123def456", "tms-min-side"},
{"no hex in suffix", "my-service-name", "my-service-name"},
{"mixed case hex no match", "my-service-DEADBEEF0123", "my-service-DEADBEEF0123"},
{"empty", "", ""},
{"only hex no dash", "abcdef0123456789", "abcdef0123456789"},
}

for _, tc := range tests {
t.Run(tc.name, func(t *testing.T) {
got := stripHexSuffix(tc.input)
if got != tc.expected {
t.Errorf("stripHexSuffix(%q) = %q, want %q", tc.input, got, tc.expected)
}
})
}
}

func TestNormalizeServiceName(t *testing.T) {
tests := []struct {
name     string
input    string
expected string
}{
{"plain service", "nav-dekoratoren", "nav-dekoratoren"},
{"FQDN full", "pdl-tilgangsstyring.pdl.svc.cluster.local", "pdl-tilgangsstyring"},
{"FQDN svc only", "pdl-tilgangsstyring.pdl.svc", "pdl-tilgangsstyring"},
{"namespace qualified", "pdl-tilgangsstyring.pdl", "pdl-tilgangsstyring"},
{"external unchanged", "vault.adeo.no", "vault.adeo.no"},
{"with port unchanged", "my-service:8080", "my-service:8080"},
{"empty", "", ""},
{"dotless", "wonderwall", "wonderwall"},
}

for _, tc := range tests {
t.Run(tc.name, func(t *testing.T) {
got := normalizeServiceName(tc.input)
if got != tc.expected {
t.Errorf("normalizeServiceName(%q) = %q, want %q", tc.input, got, tc.expected)
}
})
}
}
