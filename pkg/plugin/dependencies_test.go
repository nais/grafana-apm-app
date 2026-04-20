package plugin

import (
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
