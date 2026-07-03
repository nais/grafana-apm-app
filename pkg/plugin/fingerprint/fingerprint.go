package fingerprint

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// Version identifies the fingerprint algorithm. Bumping it re-keys every
// group, so triage state (#57) must alias old versions — be conservative
// about changes.
const Version = "v1"

// Tier records which identity source produced a fingerprint. Lower tiers are
// higher fidelity. Tier 1 (in-app stack frames) arrives with #62 Phase 2 once
// source-mapped stacks are reliable (#60).
type Tier int

const (
	// TierOverride uses an explicit fingerprint set by the SDK
	// (@nais/apm captureException fingerprint option → context_fingerprint).
	TierOverride Tier = 0
	// TierTypeMessage groups by exception type + normalized message.
	TierTypeMessage Tier = 2
	// TierMessage groups by normalized message only (no type available).
	TierMessage Tier = 3
	// TierUpstreamHash passes through the Alloy hash (no message available).
	TierUpstreamHash Tier = 4
)

// Event is the exception fields relevant to identity, as parsed from a Faro
// logfmt line in Loki.
type Event struct {
	// Type is the exception type (e.g. "TypeError"), may be empty.
	Type string
	// Value is the exception message, may be empty.
	Value string
	// UpstreamHash is Alloy's hash field (xxh3 of the raw message).
	UpstreamHash string
	// ContextFingerprint is the SDK override (context_fingerprint), may be empty.
	ContextFingerprint string
}

// Result is a computed fingerprint plus its provenance.
type Result struct {
	// Value is the versioned fingerprint, e.g. "v1:9f2ab31c04d7e655".
	Value string
	// Tier that produced the fingerprint.
	Tier Tier
	// Title is the normalized, human-readable group title
	// (e.g. "TypeError: Invalid søknad <uuid>").
	Title string
}

// Compute derives the stable issue identity for an exception event.
// It is a pure function: identical events produce identical fingerprints on
// every Grafana replica with no coordination or storage (HA-safe), and it
// applies retroactively to historical Loki data at query time.
func Compute(e Event) Result {
	title := buildTitle(e)
	switch {
	case e.ContextFingerprint != "":
		return Result{Value: hashFingerprint(TierOverride, e.ContextFingerprint), Tier: TierOverride, Title: title}
	case strings.TrimSpace(e.Value) != "" && strings.TrimSpace(e.Type) != "":
		normalized := Normalize(e.Value)
		return Result{Value: hashFingerprint(TierTypeMessage, strings.TrimSpace(e.Type), normalized), Tier: TierTypeMessage, Title: title}
	case strings.TrimSpace(e.Value) != "":
		normalized := Normalize(e.Value)
		return Result{Value: hashFingerprint(TierMessage, normalized), Tier: TierMessage, Title: title}
	default:
		return Result{Value: hashFingerprint(TierUpstreamHash, e.UpstreamHash), Tier: TierUpstreamHash, Title: title}
	}
}

func buildTitle(e Event) string {
	t := strings.TrimSpace(e.Type)
	v := Normalize(e.Value)
	switch {
	case t != "" && v != "":
		return t + ": " + v
	case v != "":
		return v
	case t != "":
		return t
	default:
		return "Unknown exception"
	}
}

// hashFingerprint builds "v1:<16 hex chars>" over the tier and its inputs,
// NUL-separated so distinct input lists cannot collide by concatenation.
func hashFingerprint(tier Tier, inputs ...string) string {
	h := sha256.New()
	h.Write([]byte{byte(tier)})
	for _, in := range inputs {
		h.Write([]byte{0})
		h.Write([]byte(in))
	}
	return Version + ":" + hex.EncodeToString(h.Sum(nil))[:16]
}

// Token replacement order matters: URLs before IPs/numbers (a URL may contain
// both), UUIDs before hex runs (a UUID is hex), timestamps before bare
// numbers. Each pattern replaces dynamic content that would otherwise
// splinter one logical error into a group per occurrence.
var (
	reWhitespace = regexp.MustCompile(`\s+`)
	reURL        = regexp.MustCompile(`(?i)\bhttps?://[^\s"']+`)
	reEmail      = regexp.MustCompile(`(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b`)
	reUUID       = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)
	reISOTime    = regexp.MustCompile(`\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?\b`)
	reIP         = regexp.MustCompile(`\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`)
	reHexRun     = regexp.MustCompile(`(?i)\b[0-9a-f]{8,}\b`)
	// Digit runs of 2+ are dynamic (ids, counts, ports) — except HTTP status
	// codes, which distinguish real error classes ("HTTP 404" vs "HTTP 500").
	reStatusCode = regexp.MustCompile(`(?i)\b(http|status|code)([ :=]+)(\d{3})\b`)
	reNumRun     = regexp.MustCompile(`\d{2,}`)
	reShielded   = regexp.MustCompile("\x00([a-j]+)\x00")
)

// shieldDigits/unshieldDigits protect HTTP status codes from the digit-run
// pass by mapping each digit to a letter ('0'→'a' … '9'→'j') inside NUL
// markers, then restoring afterwards.
func shieldDigits(digits string) string {
	var b strings.Builder
	b.WriteByte(0)
	for _, r := range digits {
		b.WriteRune('a' + (r - '0'))
	}
	b.WriteByte(0)
	return b.String()
}

func unshieldDigits(s string) string {
	return reShielded.ReplaceAllStringFunc(s, func(m string) string {
		var b strings.Builder
		for _, r := range strings.Trim(m, "\x00") {
			b.WriteRune('0' + (r - 'a'))
		}
		return b.String()
	})
}

const maxTitleLen = 256

// Normalize strips dynamic tokens from an exception message so one logical
// error maps to one group. The output doubles as the group title, so token
// placeholders are human-readable. Bonus: fnr-like identifiers and emails are
// masked out of group titles.
func Normalize(value string) string {
	s := norm.NFC.String(value)
	s = strings.TrimSpace(s)
	s = reWhitespace.ReplaceAllString(s, " ")
	s = reURL.ReplaceAllString(s, "<url>")
	s = reEmail.ReplaceAllString(s, "<email>")
	s = reUUID.ReplaceAllString(s, "<uuid>")
	s = reISOTime.ReplaceAllString(s, "<ts>")
	s = reIP.ReplaceAllString(s, "<ip>")
	// Hex runs need at least one a-f letter — otherwise a pure digit run
	// (order ids, fødselsnummer) would read as <hex> instead of <num>.
	s = reHexRun.ReplaceAllStringFunc(s, func(m string) string {
		if strings.ContainsAny(m, "abcdefABCDEF") {
			return "<hex>"
		}
		return m
	})
	// Shield HTTP status codes from the digit-run pass, then restore them.
	s = reStatusCode.ReplaceAllStringFunc(s, func(m string) string {
		parts := reStatusCode.FindStringSubmatch(m)
		return parts[1] + parts[2] + shieldDigits(parts[3])
	})
	s = reNumRun.ReplaceAllString(s, "<num>")
	s = unshieldDigits(s)
	if len(s) > maxTitleLen {
		// Truncate on a rune boundary.
		runes := []rune(s)
		if len(runes) > maxTitleLen {
			runes = runes[:maxTitleLen]
		}
		s = string(runes)
		for len(s) > maxTitleLen {
			runes = runes[:len(runes)-1]
			s = string(runes)
		}
	}
	return s
}
