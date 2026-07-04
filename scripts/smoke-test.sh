#!/usr/bin/env bash
#
# smoke-test.sh — real-environment contract harness for the Nais APM Grafana plugin.
#
# Where data-review.sh checks *data shapes* (do endpoints return the right keys
# with plausible values), this script checks the *real-environment contracts*
# that unit tests structurally cannot verify — the seams where the plugin
# depends on something outside its own code:
#
#   1. Alert-template `defaults=` contract — the URL the backend hands to
#      Grafana's rule editor must carry a `defaults=` param that decodes to a
#      valid RuleFormValues object. This breaks if Grafana changes the internal
#      contract or if our URL encoding regresses.
#   2. nais deploy sync — deploy annotations only appear when a nais API token
#      is provisioned AND the Console poll succeeded. Verifiable only live.
#   3. Triage actor attribution — the recorded actor is only a real login when
#      the call carries a signed-in user context (browser session / user token),
#      not basic-auth admin. Verifiable only with a real session.
#   4. Capabilities sanity — /capabilities must answer even when datasources are
#      unreachable, with boolean reachability flags (catches a total outage vs.
#      an endpoint that 500s).
#
# Design rule: every check SKIPs (not FAILs) when its precondition is absent —
# no token, no user session, no live datasource, an unconfigured datasource.
# The script is therefore runnable in *any* environment and only exits non-zero
# on a genuine contract break. The alert-template check needs no live datasource
# (only that a metrics/logs datasource UID is configured) and is expected to
# actually run and PASS.
#
# Dependency-light: bash + curl + python3 only.
#
# Usage:
#   bash scripts/smoke-test.sh
#   HOST=http://localhost:3000 AUTH='admin:admin' bash scripts/smoke-test.sh
#   EXPECT_DEPLOY_SYNC=1 DEPLOY_NS=navno DEPLOY_SVC=nav-enonicxp-frontend bash scripts/smoke-test.sh
#
# Env overrides:
#   HOST                Grafana base URL              (default http://localhost:3000)
#   AUTH                basic auth user:pass          (default admin:admin)
#   MAXTIME             per-request curl timeout      (default 90)
#   RANGE_SECS          lookback window in seconds    (default 21600 = 6h)
#   AT_NS / AT_SVC      service used for alert-template + triage checks
#                                                     (default pdl / pdl-api)
#   DEPLOY_NS/DEPLOY_SVC recently-deployed service for the deploy-sync check
#                                                     (default navno / nav-enonicxp-frontend)
#   EXPECT_DEPLOY_SYNC  set to 1 when a nais API token IS provisioned; otherwise
#                       the deploy-sync check SKIPs (it cannot detect the token
#                       from outside the backend)
#   USER_TOKEN          a Grafana *user* API token (glsa_… for a real user) to
#                       exercise triage actor attribution as a real login. When
#                       unset the triage check runs with $AUTH and SKIPs if that
#                       yields actor="unknown".
#   VERBOSE             set to 1 to print response snippets on failure
#
# Exit code: 0 if no check FAILs (SKIPs are fine), 1 if any check FAILs.

set -uo pipefail

HOST="${HOST:-http://localhost:3000}"
AUTH="${AUTH:-admin:admin}"
MAXTIME="${MAXTIME:-90}"
RANGE_SECS="${RANGE_SECS:-21600}"
AT_NS="${AT_NS:-pdl}"
AT_SVC="${AT_SVC:-pdl-api}"
DEPLOY_NS="${DEPLOY_NS:-navno}"
DEPLOY_SVC="${DEPLOY_SVC:-nav-enonicxp-frontend}"
EXPECT_DEPLOY_SYNC="${EXPECT_DEPLOY_SYNC:-}"
USER_TOKEN="${USER_TOKEN:-}"
VERBOSE="${VERBOSE:-0}"

BASE="$HOST/api/plugins/nais-apm-app/resources"
NOW="$(date +%s)"
FROM="$((NOW - RANGE_SECS))"
NOW_MS="$((NOW * 1000))"
FROM_MS="$((FROM * 1000))"

PASS=0; FAIL=0; SKIP=0
FAILURES=()

c() { curl -s --max-time "$MAXTIME" -u "$AUTH" "$@"; }

pass() { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %-46s %s\n' "$1" "${2:-}"; }
skip() { SKIP=$((SKIP+1)); printf '  \033[33mSKIP\033[0m %-46s %s\n' "$1" "${2:-}"; }
fail() {
  FAIL=$((FAIL+1)); FAILURES+=("$1 -> $2")
  printf '  \033[31mFAIL\033[0m %-46s %s\n' "$1" "$2"
}

# fetch <url> ; sets globals HTTP + BODY
fetch() {
  local out; out="$(c -w $'\n%{http_code}' "$1")"
  HTTP="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

# assert <name> <http_code> <body> <python-check>
# python-check reads the JSON body on stdin and prints "OK" or "FAIL: reason".
assert() {
  local name="$1" code="$2" body="$3" check="$4"
  if [ "$code" != "200" ]; then
    fail "$name" "HTTP $code"
    [ "$VERBOSE" = 1 ] && echo "       ${body:0:200}"
    return
  fi
  local res
  res="$(printf '%s' "$body" | python3 -c "$check" 2>/dev/null)" || res="FAIL: python error / bad json"
  if [ "$res" = "OK" ]; then
    pass "$name"
  else
    fail "$name" "$res"
    [ "$VERBOSE" = 1 ] && echo "       ${body:0:200}"
  fi
}

echo "=============================================================="
echo " Nais APM real-environment smoke tests"
echo " host=$HOST  range=${RANGE_SECS}s"
echo "=============================================================="

# --- 1. alert-template defaults= contract ------------------------------------
# No live datasource needed — only that a metrics/logs datasource UID is
# configured in plugin settings. A 503 ("datasource not configured") therefore
# SKIPs; a 200 is validated for the RuleFormValues `defaults=` contract.
echo; echo "### 1. alert-template defaults= contract ($AT_NS/$AT_SVC) ###"

DEFAULTS_CHECK='
import sys, json
from urllib.parse import urlparse, parse_qs
d = json.load(sys.stdin)
u = d.get("url")
if not u:
    print("FAIL: response has no url"); sys.exit()
q = parse_qs(urlparse(u).query)
raw = q.get("defaults", [None])[0]
if raw is None:
    print("FAIL: url carries no defaults= param"); sys.exit()
try:
    dd = json.loads(raw)
except Exception as e:
    print("FAIL: defaults= is not valid JSON: " + str(e)); sys.exit()
missing = [k for k in ("type", "name", "condition", "queries") if k not in dd]
if missing:
    print("FAIL: RuleFormValues missing keys " + str(missing)); sys.exit()
if not isinstance(dd["queries"], list) or len(dd["queries"]) == 0:
    print("FAIL: defaults.queries is empty"); sys.exit()
if not dd.get("condition"):
    print("FAIL: empty condition"); sys.exit()
refs = {x.get("refId") for x in dd["queries"] if isinstance(x, dict)}
if dd["condition"] not in refs:
    print("FAIL: condition %r not among query refIds %s" % (dd["condition"], sorted(r for r in refs if r))); sys.exit()
print("OK")
'

for kind in error-rate exception-spike web-vitals new-exceptions slo-burn-rate; do
  q="service=$AT_SVC&namespace=$AT_NS"
  [ "$kind" = exception-spike ] && q="$q&hash=deadbeef"
  [ "$kind" = slo-burn-rate ] && q="$q&window=fast"
  fetch "$BASE/alert-templates/$kind?$q"
  if [ "$HTTP" = "503" ]; then
    skip "alert-templates/$kind" "datasource not configured (HTTP 503)"
    continue
  fi
  assert "alert-templates/$kind" "$HTTP" "$BODY" "$DEFAULTS_CHECK"
done

# --- 2. nais deploy sync -----------------------------------------------------
echo; echo "### 2. nais deploy sync ($DEPLOY_NS/$DEPLOY_SVC) ###"
if [ "$EXPECT_DEPLOY_SYNC" != "1" ]; then
  skip "deploy-sync" "no nais API token expected (set EXPECT_DEPLOY_SYNC=1 when provisioned)"
else
  fetch "$BASE/services/$DEPLOY_NS/$DEPLOY_SVC/frontend/versions?from=$FROM&to=$NOW"
  if [ "$HTTP" != "200" ]; then
    fail "deploy-sync" "HTTP $HTTP"
    [ "$VERBOSE" = 1 ] && echo "       ${BODY:0:200}"
  else
    res="$(printf '%s' "$BODY" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if d.get("unavailable"):
    print("SKIP: versions unavailable (loki down?)"); sys.exit()
latest = d.get("latestVersion")
tagged = [v for v in d.get("versions", []) if v.get("deployedAtMs")]
if latest or tagged:
    print("OK: latest=%s tagged=%d" % (latest or "-", len(tagged)))
else:
    print("FAIL: no deploy-tagged annotations for a service expected to have deploys")
' 2>/dev/null)" || res="FAIL: python error / bad json"
    case "$res" in
      OK*)   pass "deploy-sync" "${res#OK: }" ;;
      SKIP*) skip "deploy-sync" "${res#SKIP: }" ;;
      *)     fail "deploy-sync" "$res" ;;
    esac
  fi
fi

# --- 3. triage actor attribution ---------------------------------------------
# Records a triage action and reads its actor back from the history log. A real
# login PASSes; "unknown" (basic-auth admin, no user context) SKIPs honestly.
# The test annotation is always cleaned up afterwards.
echo; echo "### 3. triage actor attribution ($AT_NS/$AT_SVC) ###"
FP="smoketest$(date +%s)"
TRIAGE_URL="$BASE/services/$AT_NS/$AT_SVC/triage/$FP"

# Use a real user token if provided, else the configured $AUTH.
if [ -n "$USER_TOKEN" ]; then
  POST_CODE="$(curl -s -o /dev/null --max-time "$MAXTIME" -w '%{http_code}' \
    -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
    -X POST "$TRIAGE_URL" -d '{"action":"resolve","note":"smoke-test"}')"
  HIST_AUTH=(-H "Authorization: Bearer $USER_TOKEN")
else
  POST_CODE="$(c -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
    -X POST "$TRIAGE_URL" -d '{"action":"resolve","note":"smoke-test"}')"
  HIST_AUTH=(-u "$AUTH")
fi

if [ "$POST_CODE" != "200" ]; then
  skip "triage-actor" "triage write unavailable (HTTP $POST_CODE — no service token?)"
else
  HIST="$(curl -s --max-time "$MAXTIME" "${HIST_AUTH[@]}" "$TRIAGE_URL/history")"
  ACTOR="$(printf '%s' "$HIST" | python3 -c '
import sys, json
d = json.load(sys.stdin)
evs = d.get("events", [])
print(evs[-1].get("actor", "") if evs else "")
' 2>/dev/null)"
  if [ -z "$ACTOR" ] || [ "$ACTOR" = "unknown" ]; then
    skip "triage-actor" "actor=\"${ACTOR:-<none>}\" — needs a real user session (set USER_TOKEN)"
  else
    pass "triage-actor" "actor=$ACTOR"
  fi

  # Cleanup: delete the annotation(s) this check created (tagged with our fp).
  # Requires annotation-write access; best-effort, reported but never fatal.
  IDS="$(c -G "$HOST/api/annotations" \
    --data-urlencode 'tags=nais-apm:triage' \
    --data-urlencode "tags=fp:$FP" 2>/dev/null \
    | python3 -c 'import sys,json;[print(a["id"]) for a in json.load(sys.stdin)]' 2>/dev/null)"
  DELETED=0
  for id in $IDS; do
    code="$(c -o /dev/null -w '%{http_code}' -X DELETE "$HOST/api/annotations/$id")"
    [ "$code" = "200" ] && DELETED=$((DELETED+1))
  done
  if [ -n "$IDS" ]; then
    echo "       cleanup: deleted $DELETED test annotation(s) for fp=$FP"
  else
    echo "       cleanup: no annotation found to delete (fp=$FP) — check annotation read access"
  fi
fi

# --- 4. capabilities sanity --------------------------------------------------
# Must answer even when datasources are down; reachability flags must be bools.
echo; echo "### 4. capabilities sanity ###"
fetch "$BASE/capabilities"
assert "capabilities" "$HTTP" "$BODY" '
import sys, json
d = json.load(sys.stdin)
sm = d.get("spanMetrics", {})
if not isinstance(sm.get("detected"), bool):
    print("FAIL: spanMetrics.detected is not a boolean"); sys.exit()
def check_flag(obj, path):
    if obj is None:
        return None
    v = obj.get("available")
    if not isinstance(v, bool):
        return "%s.available is not a boolean (got %r)" % (path, v)
    return None
for name in ("tempo", "loki"):
    err = check_flag(d.get(name), name)
    if err:
        print("FAIL: " + err); sys.exit()
for group in ("tempoByEnv", "lokiByEnv"):
    for env, st in (d.get(group) or {}).items():
        err = check_flag(st, "%s[%s]" % (group, env))
        if err:
            print("FAIL: " + err); sys.exit()
print("OK")
'

# --- summary -----------------------------------------------------------------
echo
echo "=============================================================="
echo " SUMMARY: PASS=$PASS  SKIP=$SKIP  FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo " FAILURES:"
  for f in "${FAILURES[@]}"; do echo "   - $f"; done
  echo "=============================================================="
  exit 1
fi
echo " NO CONTRACT BREAKS (skips are expected when preconditions are absent)"
echo "=============================================================="
exit 0
