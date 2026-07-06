package plugin

import (
	"regexp"
	"strings"
)

// Database statement normalization (issue #119 §4.2, §6).
//
// Every db.statement is reduced to a normalized fingerprint BEFORE it leaves
// the backend. This serves two goals at once:
//
//   - Grouping: literals, bind values and IN/VALUES-list arity are collapsed so
//     one logical query maps to one row (e.g. `IN (?, ?, ?)` == `IN (?)`).
//   - Privacy (§6): raw SQL/redis literals can contain personal data. The
//     normalized form is the ONLY thing returned to the UI — raw literals are
//     never rendered.
//
// The OTel agents already parameterize much of this (JDBC emits `?`, the Mongo
// driver emits `"?"` for values), verified live against prod Tempo 2026-07.
// We normalize further regardless, because the parameterization is inconsistent
// across languages/drivers and Redis keys arrive raw (a live probe showed
// `GET pdl::medFamilie:<id>` — a raw, potentially-PII key).

const (
	// maxStmtInput caps the raw statement length fed to the regex passes. Some
	// statements carry large embedded comment blocks; bounding input keeps the
	// normalization cost predictable.
	maxStmtInput = 8192
	// maxStmtOutput caps the normalized fingerprint length returned/rendered.
	maxStmtOutput = 400
)

var (
	reBlockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
	reLineComment  = regexp.MustCompile(`--[^\n]*`)
	// Single-quoted SQL string literals, handling the '' escape.
	reSQLString = regexp.MustCompile(`'(?:[^']|'')*'`)
	reHex       = regexp.MustCompile(`\b0[xX][0-9a-fA-F]+\b`)
	// Standalone numeric literals. Word boundaries keep digits that are part of
	// an identifier (Hibernate aliases like `fd1_0`) untouched.
	reNumber = regexp.MustCompile(`\b\d+(?:\.\d+)?\b`)
	// Postgres positional binds ($1, $2, …). Restricted to digits so Mongo
	// operators ($in, $match, …) are never mistaken for binds.
	rePgBind = regexp.MustCompile(`\$\d+`)
	// A comma-separated run of bare `?` placeholders (SQL IN/VALUES lists).
	rePlaceholderList = regexp.MustCompile(`\?(?:\s*,\s*\?)+`)
	// A comma-separated run of quoted "?" placeholders (Mongo/JSON $in arrays).
	reJSONPlaceholderList = regexp.MustCompile(`"\?"(?:\s*,\s*"\?")+`)
	reWhitespace          = regexp.MustCompile(`\s+`)
)

// dbFamily groups db.system values by the statement grammar they use, which
// decides how the statement is safely normalized.
type dbFamily int

const (
	familySQL dbFamily = iota
	familyKeyValue
	familyDocument
)

// classifyDBFamily maps a db.system to its statement grammar family. Unknown
// systems default to the SQL normalizer (the strongest literal-stripping),
// which is the safe default for PII.
func classifyDBFamily(system string) dbFamily {
	switch strings.ToLower(strings.TrimSpace(system)) {
	case "redis", "valkey", "keydb", "memcached", "dragonfly":
		return familyKeyValue
	case "mongodb", "opensearch", "elasticsearch", "couchbase":
		return familyDocument
	default:
		// postgresql, oracle, db2, h2, mysql, mariadb, mssql, other_sql,
		// cassandra, clickhouse, cockroachdb, … — all SQL-ish.
		return familySQL
	}
}

// normalizeStatement reduces a raw db.statement to a system-aware, PII-safe
// fingerprint. Returns "" when the statement carries no useful shape.
func normalizeStatement(system, stmt string) string {
	stmt = strings.TrimSpace(stmt)
	if stmt == "" {
		return ""
	}
	if len(stmt) > maxStmtInput {
		stmt = stmt[:maxStmtInput]
	}

	switch classifyDBFamily(system) {
	case familyKeyValue:
		return normalizeKeyValue(stmt)
	case familyDocument:
		return normalizeDocument(stmt)
	default:
		return normalizeSQL(stmt)
	}
}

// normalizeSQL strips comments and every literal (string, number, hex, bind)
// to `?`, then collapses IN/VALUES-list arity and whitespace. Single-quoted
// string literals are removed outright, so raw SQL PII cannot survive even when
// the agent failed to parameterize it.
func normalizeSQL(stmt string) string {
	s := reBlockComment.ReplaceAllString(stmt, " ")
	s = reLineComment.ReplaceAllString(s, " ")
	s = reSQLString.ReplaceAllString(s, "?")
	// Positional binds before the numeric pass, so `$1` collapses to `?` rather
	// than the number regex eating the digit and leaving `$?`.
	s = rePgBind.ReplaceAllString(s, "?")
	s = reHex.ReplaceAllString(s, "?")
	s = reNumber.ReplaceAllString(s, "?")
	s = reJSONPlaceholderList.ReplaceAllString(s, `"?"`)
	s = rePlaceholderList.ReplaceAllString(s, "?")
	return finishStatement(s)
}

// normalizeDocument handles JSON-shaped statements (Mongo/OpenSearch). It does
// NOT strip double-quoted strings — those are field names and the driver-
// emitted `"?"` value placeholders, and rewriting them would destroy the query
// shape. Values are relied upon to be agent-parameterized (verified live);
// bare numbers are still stripped and $in arrays collapsed.
func normalizeDocument(stmt string) string {
	s := reNumber.ReplaceAllString(stmt, "?")
	s = reJSONPlaceholderList.ReplaceAllString(s, `"?"`)
	s = rePlaceholderList.ReplaceAllString(s, "?")
	return finishStatement(s)
}

// normalizeKeyValue collapses a Redis/valkey command to `VERB ?` (or just
// `VERB` when it takes no argument). The key/value arguments are dropped
// entirely — they arrive raw from the driver and may carry PII.
func normalizeKeyValue(stmt string) string {
	fields := strings.Fields(stmt)
	if len(fields) == 0 {
		return ""
	}
	cmd := strings.ToUpper(fields[0])
	if len(fields) == 1 {
		return cmd
	}
	return cmd + " ?"
}

// finishStatement collapses whitespace, trims, and truncates to the output cap.
func finishStatement(s string) string {
	s = reWhitespace.ReplaceAllString(s, " ")
	s = strings.TrimSpace(s)
	if len(s) > maxStmtOutput {
		s = strings.TrimSpace(s[:maxStmtOutput]) + "…"
	}
	return s
}
