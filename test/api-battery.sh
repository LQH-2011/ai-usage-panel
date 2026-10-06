#!/usr/bin/env bash
# API battery — run against `npm run dev` (with test/mock-upstream.js running).
#   bash test/api-battery.sh
set -u

BASE=${BASE:-http://127.0.0.1:3000}
ENV_FILE=${ENV_FILE:-.env}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1));
  else printf '  \033[31m✗\033[0m %s (expected %s, got %s)\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}
# jget <file> <dotted.path>
jget() {
  node -e '
    const fs=require("fs");let j={};
    try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
    let v=j;for(const k of process.argv[2].split(".")) v=(v==null?undefined:v[k]);
    console.log(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):v));
  ' "$1" "$2"
}

echo "── auth ─────────────────────────────────────────────"
code=$(curl -sS -o "$TMP/wrong.json" -w '%{http_code}' -X POST "$BASE/api/auth" \
  -H 'Content-Type: application/json' -d '{"password":"definitely-wrong"}')
check "wrong password → 401" 401 "$code"

code=$(curl -sS -o "$TMP/auth.json" -w '%{http_code}' -X POST "$BASE/api/auth" \
  -H 'Content-Type: application/json' -d '{"password":"test-password-123"}')
check "correct password → 200" 200 "$code"
TOKEN=$(jget "$TMP/auth.json" token)
[ -n "$TOKEN" ] && check "token returned" yes yes || check "token returned" yes no

code=$(curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE/api/auth")
check "OPTIONS preflight → 204" 204 "$code"

echo "── authorization ────────────────────────────────────"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/overview")
check "overview without token → 401" 401 "$code"

code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/overview" -H 'Authorization: Bearer not.a.token')
check "forged token → 401" 401 "$code"

EXPIRED=$(node -e '
  const fs=require("fs"),crypto=require("crypto");
  const env=fs.readFileSync(process.argv[1],"utf8");
  const secret=/^AUTH_TOKEN_SECRET=(.*)$/m.exec(env)[1].trim();
  const p=Buffer.from(JSON.stringify({sub:"x",exp:Date.now()-5000})).toString("base64url");
  console.log(p+"."+crypto.createHmac("sha256",secret).update(p).digest("hex"));
' "$ENV_FILE")
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/overview" -H "Authorization: Bearer $EXPIRED")
check "expired token → 401" 401 "$code"

code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/collect")
check "collect without auth → 401" 401 "$code"

echo "── collect ──────────────────────────────────────────"
code=$(curl -sS -o "$TMP/collect1.json" -w '%{http_code}' -X POST "$BASE/api/collect" -H "Authorization: Bearer $TOKEN")
check "collect (session token) → 200" 200 "$code"
check "  aihubmix.ok" true "$(jget "$TMP/collect1.json" report.aihubmix.ok)"
check "  deepseek.ok" true "$(jget "$TMP/collect1.json" report.deepseek.ok)"
check "  aihubmix keys = 3" 3 "$(jget "$TMP/collect1.json" report.aihubmix.keys)"
check "  deepseek usage rows > 0" yes "$([ "$(jget "$TMP/collect1.json" report.deepseek.usage_rows)" -gt 0 ] && echo yes)"

code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/collect" -H 'x-cron-secret: test-cron-secret')
check "collect (cron secret) → 200" 200 "$code"

# a second collection so the window contains two points and a real delta
curl -sS -o /dev/null -X POST "$BASE/api/collect" -H "Authorization: Bearer $TOKEN"
sleep 1
curl -sS -o /dev/null -X POST "$BASE/api/collect" -H "Authorization: Bearer $TOKEN"

echo "── overview ─────────────────────────────────────────"
code=$(curl -sS -o "$TMP/ov.json" -w '%{http_code}' "$BASE/api/overview" -H "Authorization: Bearer $TOKEN")
check "overview → 200" 200 "$code"
check "  aihubmix configured" true "$(jget "$TMP/ov.json" aihubmix.configured)"
check "  deepseek configured" true "$(jget "$TMP/ov.json" deepseek.configured)"
check "  deepseek balance = 110" 110 "$(jget "$TMP/ov.json" deepseek.total_balance)"
check "  aihubmix keys listed = 3" 3 "$(node -e 'const fs=require("fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).aihubmix.keys.length)' "$TMP/ov.json")"

echo "── usage ────────────────────────────────────────────"
code=$(curl -sS -o "$TMP/u7.json" -w '%{http_code}' "$BASE/api/usage?range=7d" -H "Authorization: Bearer $TOKEN")
check "usage 7d → 200" 200 "$code"
check "  range key = 7d" 7d "$(jget "$TMP/u7.json" range.key)"
check "  aihubmix series > 0" yes "$([ "$(node -e 'const fs=require("fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).aihubmix.series.length)' "$TMP/u7.json")" -gt 0 ] && echo yes)"
check "  keys > 0" yes "$([ "$(node -e 'const fs=require("fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).aihubmix.keys.length)' "$TMP/u7.json")" -gt 0 ] && echo yes)"
check "  deepseek models = 2" 2 "$(node -e 'const fs=require("fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).deepseek.models.length)' "$TMP/u7.json")"
check "  deepseek usage_currency = CNY" CNY "$(jget "$TMP/u7.json" deepseek.usage_currency)"

SPEND=$(node -e 'const fs=require("fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).aihubmix.spend_usd)' "$TMP/u7.json")
check "  aihubmix spend > 0 (delta between snapshots)" yes "$(node -e "console.log(Number(process.argv[1])>0?'yes':'no')" "$SPEND")"

for r in 24h 30d 90d all; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/usage?range=$r" -H "Authorization: Bearer $TOKEN")
  check "usage range=$r → 200" 200 "$code"
done
code=$(curl -sS -o "$TMP/uc.json" -w '%{http_code}' "$BASE/api/usage?from=2026-01-01&to=2026-12-31" -H "Authorization: Bearer $TOKEN")
check "usage custom from/to → 200" 200 "$code"
check "  range key = custom" custom "$(jget "$TMP/uc.json" range.key)"

echo "── routing / rate limit ─────────────────────────────"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/nope")
check "unknown api route → 404" 404 "$code"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/")
check "index.html served → 200" 200 "$code"

LIMITED=0
for i in $(seq 1 12); do
  c=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth" \
    -H 'Content-Type: application/json' -d '{"password":"still-wrong"}')
  [ "$c" = "429" ] && LIMITED=1
done
check "11+ wrong passwords → 429" 1 "$LIMITED"
# NOTE: this locks login from this IP for the limiter window (~15 min). Restart
# the dev server to clear it before running other checks against the same host.

echo
printf 'RESULT: \033[32m%d passed\033[0m, \033[31m%d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
