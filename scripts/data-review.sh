#!/usr/bin/env bash
#
# data-review.sh — data-conformance harness for the Nais APM Grafana plugin.
#
# Sweeps every backend resource endpoint across a configurable service matrix
# and asserts basic conformance:
#   * HTTP 200 (non-error)
#   * required schema keys present (checked with python3)
#   * non-empty payloads where the matrix declares data should exist
#
# Dependency-light: bash + curl + python3 only.
#
# Usage:
#   bash scripts/data-review.sh
#   HOST=http://localhost:3000 AUTH='admin:admin' bash scripts/data-review.sh
#   MATRIX_FILE=/path/to/matrix.tsv bash scripts/data-review.sh   # override matrix
#
# Env overrides:
#   HOST        Grafana base URL            (default http://localhost:3000)
#   AUTH        basic auth user:pass        (default admin:admin)
#   LOKI_UID    logs datasource uid         (default nav-logs)
#   TEMPO_UID   traces datasource uid       (default dev-gcp-tempo)
#   RANGE_SECS  lookback window in seconds  (default 21600 = 6h)
#   MAXTIME     per-request curl timeout    (default 90; uncached traceql breakdowns can take ~20s+)
#   MATRIX_FILE tab-separated matrix file   (default: built-in matrix)
#   VERBOSE     set to 1 to print response snippets on failure
#
# Matrix row format (TSV):  namespace <TAB> service <TAB> label <TAB> flags
#   flags is a comma list drawn from:
#     issues       -> issues/exceptions must be non-empty
#     runtime_db   -> runtime.dbPool must be present + coherent (idle<=max)
#     frontend     -> frontend metrics.available must be true
#     logs         -> logs/patterns mode must not be "unavailable"
#     traces       -> traces/breakdown must return rows (not empty)
#   Use "_" as namespace for services with an empty namespace (webjs frontends).
#
# Exit code: 0 if all assertions pass, 1 if any FAIL.

set -uo pipefail

HOST="${HOST:-http://localhost:3000}"
AUTH="${AUTH:-admin:admin}"
LOKI_UID="${LOKI_UID:-nav-logs}"
TEMPO_UID="${TEMPO_UID:-dev-gcp-tempo}"
RANGE_SECS="${RANGE_SECS:-21600}"
MAXTIME="${MAXTIME:-90}"
VERBOSE="${VERBOSE:-0}"

BASE="$HOST/api/plugins/nais-apm-app/resources"
NOW="$(date +%s)"
FROM="$((NOW - RANGE_SECS))"

PASS=0; FAIL=0; SKIP=0
FAILURES=()

c() { curl -s --max-time "$MAXTIME" -u "$AUTH" "$@"; }

# assert <name> <http_code> <body> <python-check>
# python-check reads the JSON body on stdin and must print exactly "OK" or "FAIL: reason"
assert() {
  local name="$1" code="$2" body="$3" check="$4"
  if [ "$code" != "200" ]; then
    FAIL=$((FAIL+1)); FAILURES+=("$name -> HTTP $code")
    printf '  \033[31mFAIL\033[0m %-52s HTTP %s\n' "$name" "$code"
    [ "$VERBOSE" = 1 ] && echo "       ${body:0:200}"
    return
  fi
  local res
  res="$(printf '%s' "$body" | python3 -c "$check" 2>/dev/null)" || res="FAIL: python error / bad json"
  if [ "$res" = "OK" ]; then
    PASS=$((PASS+1))
    printf '  \033[32mPASS\033[0m %-52s\n' "$name"
  else
    FAIL=$((FAIL+1)); FAILURES+=("$name -> $res")
    printf '  \033[31mFAIL\033[0m %-52s %s\n' "$name" "$res"
    [ "$VERBOSE" = 1 ] && echo "       ${body:0:200}"
  fi
}

# fetch <url> ; sets globals HTTP + BODY
fetch() {
  local out; out="$(c -w $'\n%{http_code}' "$1")"
  HTTP="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

has_flag() { case ",$1," in *,"$2",*) return 0;; *) return 1;; esac; }

# --- built-in matrix (override with MATRIX_FILE) -----------------------------
default_matrix() {
  cat <<'TSV'
helsearbeidsgiver	hag-dokument-proxy	nodeSSR	logs
navno	nav-enonicxp-frontend	node	issues,frontend,logs
amt	amt-distribusjon	jvmKtor	issues,logs
navno	navno-search-frontend	plaintext	logs
pdl	pdl-api	mongodb	logs,traces
pensjon-person	pensjon-representasjon	oracleUCP	runtime_db,logs
teamforeldrepenger	fpinntektsmelding	pgHikari	runtime_db,logs
tilbake	tilbakekreving-backend	chattyErr	issues,runtime_db,logs
min-side	tms-min-side	node	frontend,logs
_	dp-rapportering-frontend	webjsFE	frontend
team-researchops	reops-event-proxy	randSpring	logs
TSV
}

echo "=============================================================="
echo " Nais APM data-conformance review"
echo " host=$HOST  range=${RANGE_SECS}s  loki=$LOKI_UID  tempo=$TEMPO_UID"
echo "=============================================================="

# --- global (non service-scoped) endpoints -----------------------------------
echo; echo "### global endpoints ###"

fetch "$BASE/capabilities"
assert "capabilities" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if not d.get("spanMetrics",{}).get("detected"): print("FAIL: spanMetrics.detected false"); sys.exit()
if not d.get("services"): print("FAIL: services empty"); sys.exit()
print("OK")'

fetch "$BASE/services?from=$FROM&to=$NOW"
assert "services" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if not isinstance(d,list) or len(d)==0: print("FAIL: inventory empty"); sys.exit()
k={"name","namespace","rate","errorRate","p95Duration"}
if not k.issubset(d[0]): print("FAIL: missing keys "+str(k-set(d[0]))); sys.exit()
print("OK")'

fetch "$BASE/jobs?from=$FROM&to=$NOW"
assert "jobs" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if not d.get("available"): print("FAIL: available false ("+d.get("note","")[:60]+")"); sys.exit()
if not d.get("jobs"): print("FAIL: jobs empty"); sys.exit()
print("OK")'

fetch "$BASE/service-map/clustered?from=$FROM&to=$NOW"
assert "service-map/clustered" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if not d.get("nodes"): print("FAIL: nodes empty"); sys.exit()
if not d.get("edges"): print("FAIL: edges empty"); sys.exit()
print("OK")'

# alert templates (require a real service that has metrics + logs)
AT_NS="pdl"; AT_SVC="pdl-api"
for kind in error-rate exception-spike web-vitals new-exceptions slo-burn-rate; do
  q="service=$AT_SVC&namespace=$AT_NS"
  [ "$kind" = exception-spike ] && q="$q&hash=deadbeef"
  fetch "$BASE/alert-templates/$kind?$q"
  assert "alert-templates/$kind" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if not d.get("url"): print("FAIL: no url"); sys.exit()
if not d.get("defaults",{}).get("queries"): print("FAIL: no queries"); sys.exit()
print("OK")'
done

# --- per-service sweep -------------------------------------------------------
MATRIX="$(if [ -n "${MATRIX_FILE:-}" ]; then cat "$MATRIX_FILE"; else default_matrix; fi)"

while IFS=$'\t' read -r NS SVC LABEL FLAGS; do
  [ -z "${NS:-}" ] && continue
  case "$NS" in \#*) continue;; esac
  FLAGS="${FLAGS:-}"
  echo; echo "### $NS/$SVC ($LABEL) [$FLAGS] ###"
  P="$BASE/services/$NS/$SVC"

  fetch "$P/health?from=$FROM&to=$NOW"
  assert "$SVC health" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if "durationUnit" not in d: print("FAIL: no durationUnit"); sys.exit()
for k in ("rate","errorRate","p95Duration"):
  if k not in d: print("FAIL: missing "+k); sys.exit()
print("OK")'

  fetch "$P/issues?from=$FROM&to=$NOW"
  if has_flag "$FLAGS" issues; then
    assert "$SVC issues (non-empty)" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
for k in ("sources","issues","facets" if False else "issues"):
  if k not in d: print("FAIL: missing "+k); sys.exit()
if len(d.get("issues",[]))==0: print("FAIL: issues empty but data expected"); sys.exit()
print("OK")'
  else
    assert "$SVC issues (shape)" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
for k in ("sources","issues"):
  if k not in d: print("FAIL: missing "+k); sys.exit()
print("OK")'
  fi

  fetch "$P/exceptions/groups?from=$FROM&to=$NOW"
  assert "$SVC exceptions/groups" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if "groups" not in d: print("FAIL: no groups key"); sys.exit()
print("OK")'

  fetch "$P/triage?from=$FROM&to=$NOW"
  assert "$SVC triage" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if "states" not in d: print("FAIL: no states key"); sys.exit()
print("OK")'

  fetch "$P/frontend?from=$FROM&to=$NOW"
  if has_flag "$FLAGS" frontend; then
    assert "$SVC frontend/metrics (available)" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if "available" not in d: print("FAIL: no available key"); sys.exit()
if not d.get("available"): print("FAIL: available=false but frontend expected"); sys.exit()
print("OK")'
  else
    assert "$SVC frontend/metrics (shape)" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if "available" not in d: print("FAIL: no available key"); sys.exit()
print("OK")'
  fi

  fetch "$P/frontend/sessions?from=$FROM&to=$NOW"
  assert "$SVC frontend/sessions" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if "sessions" not in d: print("FAIL: no sessions key"); sys.exit()
print("OK")'

  fetch "$P/frontend/versions?from=$FROM&to=$NOW"
  assert "$SVC frontend/versions" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if "versions" not in d: print("FAIL: no versions key"); sys.exit()
print("OK")'

  fetch "$P/feedback?from=$FROM&to=$NOW"
  assert "$SVC feedback" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if "feedback" not in d: print("FAIL: no feedback key"); sys.exit()
print("OK")'

  fetch "$P/logs/patterns?from=$FROM&to=$NOW&lokiUid=$LOKI_UID"
  if has_flag "$FLAGS" logs; then
    assert "$SVC logs/patterns (available)" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if "mode" not in d or "patterns" not in d: print("FAIL: missing mode/patterns"); sys.exit()
if d.get("mode")=="unavailable": print("FAIL: mode=unavailable ("+d.get("note","")[:50]+")"); sys.exit()
print("OK")'
  else
    assert "$SVC logs/patterns (shape)" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
if "mode" not in d or "patterns" not in d: print("FAIL: missing mode/patterns"); sys.exit()
print("OK")'
  fi

  fetch "$P/traces/breakdown?from=$FROM&to=$NOW&tracesUid=$TEMPO_UID&dimension=name"
  if has_flag "$FLAGS" traces; then
    assert "$SVC traces/breakdown (rows)" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
for k in ("mode","dimensions","rows"):
  if k not in d: print("FAIL: missing "+k); sys.exit()
if d.get("mode")=="unavailable": print("FAIL: mode=unavailable"); sys.exit()
if len(d.get("rows",[]))==0: print("FAIL: rows empty but traces expected"); sys.exit()
print("OK")'
  else
    assert "$SVC traces/breakdown (shape)" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
for k in ("mode","dimensions","rows"):
  if k not in d: print("FAIL: missing "+k); sys.exit()
print("OK")'
  fi

  fetch "$P/scorecard?from=$FROM&to=$NOW"
  assert "$SVC scorecard" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
r=d.get("readiness",{})
if r.get("total")!=6: print("FAIL: readiness.total != 6 (got "+str(r.get("total"))+")"); sys.exit()
if len(r.get("checks",[]))!=6: print("FAIL: expected 6 checks"); sys.exit()
print("OK")'

  fetch "$P/runtime?from=$FROM&to=$NOW"
  if has_flag "$FLAGS" runtime_db; then
    assert "$SVC runtime.dbPool (coherent)" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
db=d.get("dbPool")
if not db or not db.get("pools"): print("FAIL: dbPool missing but db app"); sys.exit()
bad=[p["name"] for p in db["pools"] if p.get("idle",0) > p.get("max",0) > 0]
if bad: print("FAIL: idle>max (pod-aggregation) pools="+str(bad)[:60]); sys.exit()
print("OK")'
  else
    assert "$SVC runtime (shape)" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
# runtime always returns an object; container/jvm/nodejs vary by service
if not isinstance(d,dict): print("FAIL: not an object"); sys.exit()
print("OK")'
  fi

  fetch "$P/endpoints?from=$FROM&to=$NOW"
  assert "$SVC endpoints" "$HTTP" "$BODY" '
import sys,json
d=json.load(sys.stdin)
for k in ("http","database","durationUnit"):
  if k not in d: print("FAIL: missing "+k); sys.exit()
print("OK")'

done <<< "$MATRIX"

# --- summary -----------------------------------------------------------------
echo
echo "=============================================================="
echo " SUMMARY: PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
if [ "$FAIL" -gt 0 ]; then
  echo " FAILURES:"
  for f in "${FAILURES[@]}"; do echo "   - $f"; done
  echo "=============================================================="
  exit 1
fi
echo " ALL CONFORMANCE CHECKS PASSED"
echo "=============================================================="
exit 0
