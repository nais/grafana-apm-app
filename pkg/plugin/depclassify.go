package plugin

import "strings"

// classifyDependency determines the dependency type using service-graph
// connection_type, db_system from the service graph, and messaging_system labels.
func classifyDependency(name, connType string, dbSystemMap, messagingSystemMap map[string]string) string {
	switch connType {
	case "database":
		// Resolve specific DB type from service graph db_system label
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
		if msgSys, ok := messagingSystemMap[name]; ok {
			return normalizeMessagingSystem(msgSys)
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

// normalizeMessagingSystem maps OTel messaging.system values to our display types.
func normalizeMessagingSystem(msgSys string) string {
	switch strings.ToLower(msgSys) {
	case "kafka":
		return "kafka"
	case "rabbitmq":
		return "rabbitmq"
	default:
		return "messaging"
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
	case isExternalHostname(lower):
		return "external"
	default:
		return "service"
	}
}

// isExternalHostname returns true if the name looks like an external hostname
// rather than a Kubernetes internal service address (service.namespace).
//
// Heuristic:
//   - 1 part (no dots): internal K8s service name
//   - 2 parts: check if the second part is a known TLD (.no, .com, .io, etc.)
//     If yes → external (e.g., "idporten.no"). If no → internal K8s (e.g.,
//     "sokos-kontoregister-person.okonomi" where "okonomi" is a namespace).
//   - 3+ parts: external (e.g., "graph.microsoft.com", "pdl-api.prod-fss-pub.nais.io")
func isExternalHostname(name string) bool {
	// host:port with dots in the host part → check the host
	if strings.Contains(name, ":") {
		host, _, _ := strings.Cut(name, ":")
		return isExternalHostname(host)
	}
	// K8s FQDN patterns → internal
	if strings.Contains(name, ".svc.") || strings.HasSuffix(name, ".svc") {
		return false
	}
	parts := strings.Split(name, ".")
	switch len(parts) {
	case 1:
		return false // bare service name
	case 2:
		// 2-part: external only if the suffix is a known TLD
		return isKnownTLD(parts[1])
	default:
		return true // 3+ parts → external hostname
	}
}

// isKnownTLD returns true if the suffix matches a recognized top-level domain.
// This distinguishes "idporten.no" (external) from "norg2.org-namespace" (K8s).
func isKnownTLD(suffix string) bool {
	switch strings.ToLower(suffix) {
	case "com", "org", "net", "io", "no", "se", "dk", "fi", "uk", "de", "fr",
		"eu", "dev", "app", "cloud", "edu", "gov", "mil", "int", "biz", "info",
		"co", "us", "ca", "au", "nl", "be", "ch", "at", "pl", "it", "es", "pt":
		return true
	}
	return false
}

// looksLikeHostname returns true if the name contains dots or colons (host:port),
// indicating a hostname rather than a bare service name.
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

// normalizeServiceName strips K8s FQDN suffixes to produce a short service name.
// Examples:
//
//	"pdl-tilgangsstyring.pdl.svc.nais.local" → "pdl-tilgangsstyring"
//	"pdl-tilgangsstyring.pdl.svc.cluster.local" → "pdl-tilgangsstyring"
//	"pdl-tilgangsstyring.pdl.svc" → "pdl-tilgangsstyring"
//	"pdl-tilgangsstyring.pdl" → "pdl-tilgangsstyring" (namespace-qualified)
//	"vault.adeo.no" → "vault.adeo.no" (external, unchanged)
//	"pdl-tilgangsstyring" → "pdl-tilgangsstyring" (already short)
func normalizeServiceName(name string) string {
	// Strip port if present
	host := name
	if idx := strings.IndexByte(name, ':'); idx != -1 {
		host = name[:idx]
	}

	parts := strings.Split(host, ".")
	if len(parts) < 2 {
		return name
	}

	// Pattern: {service}.{namespace}.svc[.anything]
	if len(parts) >= 3 && parts[2] == "svc" {
		return parts[0]
	}

	// Pattern: {service}.{namespace} — only if second part is NOT a known TLD
	if len(parts) == 2 && !isKnownTLD(parts[1]) {
		return parts[0]
	}

	return name
}

// extractK8sNamespace returns the namespace portion of a K8s service name, or "".
func extractK8sNamespace(name string) string { //nolint:unused
	host := name
	if idx := strings.IndexByte(name, ':'); idx != -1 {
		host = name[:idx]
	}

	parts := strings.Split(host, ".")
	if len(parts) >= 3 && parts[2] == "svc" {
		return parts[1]
	}
	if len(parts) == 2 && !isKnownTLD(parts[1]) {
		return parts[1]
	}
	return ""
}
