#!/bin/sh
# Checks the local production rehearsal (docker/compose.local.yml) through Caddy, as a visitor
# would (T4.3, D60). -k: Caddy's local certificate is its own.
set -eu
site=https://tally.localhost:8443
fail() { echo "FAIL: $1"; exit 1; }

[ "$(curl -fsk "$site/api/health")" = ok ] || fail "/api/health does not answer ok"
echo "ok: /api/health answers ok"

curl -fsk -D - -o /dev/null "$site/api/health" | grep -qi '^cache-control: no-store' || fail "/api has no Cache-Control: no-store"
echo "ok: /api is not cached"

redirect=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' http://tally.localhost:8080/)
case "$redirect" in 30[178]\ https://tally.localhost*) echo "ok: http redirects to https" ;; *) fail "http answers: $redirect" ;; esac

headers=$(curl -fsk -D - -o /dev/null "$site/")
for h in strict-transport-security content-security-policy x-content-type-options referrer-policy \
  permissions-policy cross-origin-opener-policy; do
  echo "$headers" | grep -qi "^$h:" || fail "no $h header"
done
echo "$headers" | grep -qi '^server:' && fail "the Server header is still sent"
echo "ok: security headers present, no Server header"

curl -fsk "$site/months/any" | grep -q '<div id="root"' || fail "a page address does not get the app"
echo "ok: page addresses get the app (index.html)"
