package plugin

import "strings"

// classifyDependency determines the dependency type using service-graph
// connection_type and optionally enriching database types from spanmetrics.
func classifyDependency(name, connType string, dbSystemMap map[string]string) string {
	switch connType {
	case "database":
		// Try to resolve specific DB type from spanmetrics enrichment
		if dbSys, ok := dbSystemMap[name]; ok {
			return normalizeDBSystem(dbSys)
		}
		// Fallback: try hostname pattern matching
		return inferDBFromHostname(name)

	case "messaging_system":
		// If the server is a plain service name (not a broker hostname), this
		// represents a producer→consumer edge: the consumer is not a dependency
		// of the producer but rather a downstream subscriber. Classify these as
		// "service" so they are excluded from the dependencies list and appear
		// only in connected services.
		if !looksLikeHostname(name) && !isKnownBrokerName(name) {
			return "service"
		}
		return "kafka"

	case "virtual_node":
		return "external"
	}

	// No connection_type — check if we can still classify by name patterns
	if dbSys, ok := dbSystemMap[name]; ok {
		return normalizeDBSystem(dbSys)
	}
	return inferFromName(name)
}

// normalizeDBSystem maps OTel db.system values to our display types.
func normalizeDBSystem(dbSys string) string {
	switch dbSys {
	case "postgresql", "postgres":
		return "postgresql"
	case "oracle":
		return "oracle"
	case "mongodb", "mongo":
		return "mongodb"
	case "redis":
		return "redis"
	case "mysql", "mariadb":
		return "mysql"
	case "db2":
		return "db2"
	case "opensearch", "elasticsearch":
		return "opensearch"
	case "h2":
		return "h2"
	case "other_sql":
		return "database"
	default:
		return "database"
	}
}

// inferDBFromHostname uses hostname patterns common at Nav.
func inferDBFromHostname(name string) string {
	lower := strings.ToLower(name)
	if strings.HasPrefix(lower, "dmv") && strings.Contains(lower, "-scan") {
		return "oracle" // Oracle RAC scan listeners
	}
	if strings.HasPrefix(lower, "a01db") {
		return "postgresql" // Nav on-prem PostgreSQL hosts
	}
	if strings.Contains(lower, "redis") || strings.Contains(lower, "valkey") {
		return "redis"
	}
	if strings.Contains(lower, "opensearch") || strings.Contains(lower, "elastic") {
		return "opensearch"
	}
	if strings.Contains(lower, "mongo") {
		return "mongodb"
	}
	return "database"
}

// inferFromName classifies by name when no connection_type is available.
func inferFromName(name string) string {
	lower := strings.ToLower(name)
	switch {
	case lower == "redis" || lower == "valkey":
		return "redis"
	case lower == "kafka":
		return "kafka"
	case strings.Contains(lower, "redis") || strings.Contains(lower, "valkey") ||
		strings.HasSuffix(lower, ".aivencloud.com"):
		return "redis"
	case looksLikeHostname(lower):
		return "external"
	default:
		return "service"
	}
}

// looksLikeHostname returns true if the name contains dots or colons (host:port),
// indicating an external hostname rather than an internal service name.
func looksLikeHostname(name string) bool {
	return strings.Contains(name, ".") || strings.Contains(name, ":")
}

// isKnownBrokerName returns true if the name matches a well-known message broker
// name that should appear as a dependency (e.g., "kafka", "rabbitmq").
func isKnownBrokerName(name string) bool {
	lower := strings.ToLower(name)
	switch lower {
	case "kafka", "rabbitmq", "nats", "pulsar", "activemq", "redis":
		return true
	}
	return false
}
