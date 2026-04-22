package plugin

import (
	"regexp"
	"testing"
)

func TestClassifyDependency(t *testing.T) {
	tests := []struct {
		name       string
		depName    string
		connType   string
		dbSysMap   map[string]string
		expected   string
	}{
		// database connection type with db.system enrichment
		{"postgres from db.system", "mydb-host", "database", map[string]string{"mydb-host": "postgresql"}, "postgresql"},
		{"oracle from db.system", "orahost", "database", map[string]string{"orahost": "oracle"}, "oracle"},
		{"redis from db.system", "cache-host", "database", map[string]string{"cache-host": "redis"}, "redis"},
		{"mongodb from db.system", "mongo-host", "database", map[string]string{"mongo-host": "mongodb"}, "mongodb"},

		// database connection type with hostname inference
		{"oracle RAC scan", "dmv04-scan.oera.no", "database", nil, "oracle"},
		{"nav postgres host", "a01dbvl123.oera.no", "database", nil, "postgresql"},
		{"redis in hostname", "my-redis-cluster", "database", nil, "redis"},
		{"valkey in hostname", "test-valkey-01", "database", nil, "redis"},
		{"opensearch in hostname", "logs-opensearch-01", "database", nil, "opensearch"},
		{"unknown db host", "some-random-host", "database", nil, "database"},

		// messaging system
		{"kafka messaging", "my-topic", "messaging_system", nil, "kafka"},

		// virtual node
		{"external virtual node", "api.example.com", "virtual_node", nil, "external"},

		// no connection type — db.system map lookup
		{"no conntype postgres", "mydb", "", map[string]string{"mydb": "postgresql"}, "postgresql"},

		// no connection type — name inference
		{"no conntype redis name", "redis", "", nil, "redis"},
		{"no conntype valkey name", "valkey", "", nil, "redis"},
		{"no conntype kafka name", "kafka", "", nil, "kafka"},
		{"no conntype aiven redis", "my-app-redis-01.aivencloud.com", "", nil, "redis"},
		{"no conntype unknown name", "some-service", "", nil, "service"},

		// nil dbSysMap with database type
		{"nil map database", "host.example.com", "database", nil, "database"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyDependency(tc.depName, tc.connType, tc.dbSysMap)
			if got != tc.expected {
				t.Errorf("classifyDependency(%q, %q, %v) = %q, want %q",
					tc.depName, tc.connType, tc.dbSysMap, got, tc.expected)
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
		{"regular service", "my-other-app", "service"},
		{"external domain", "idporten.no", "external"},
		{"external domain with subdomain", "graph.microsoft.com", "external"},
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
