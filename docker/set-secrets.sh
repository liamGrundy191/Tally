#!/bin/bash
# Puts the secret settings into /opt/tally/.env without them ever passing through chat, email or
# GitHub (T4.3, D60). Run it on the server, from DigitalOcean's web console:
#   sudo bash /opt/tally/set-secrets.sh
# It asks for each secret in turn; what you paste is not shown. Press Enter to keep a value as it
# is. Every other line of the file is left alone. Usage for a test: set-secrets.sh <file>.
set -euo pipefail
file=${1:-/opt/tally/.env}
tmp=
trap 'rm -f "$tmp"' EXIT

# Writes KEY='value'. Single quotes keep $, #, spaces and & exactly as typed, for Docker Compose.
set_line() {
  local key=$1 value=$2
  if [[ $value == *"'"* ]]; then
    echo "  Not saved: $key contains a ' (single quote). Create a new value without one." >&2
    return 1
  fi
  tmp=$(mktemp "$file.XXXX")
  grep -v "^$key=" "$file" > "$tmp" || true
  printf "%s='%s'\n" "$key" "$value" >> "$tmp"
  chmod 600 "$tmp"
  chown --reference="$file" "$tmp"
  mv "$tmp" "$file"
  tmp=
}

# Percent-encodes a password for a database address (its characters are ASCII).
urlencode() {
  local s=$1 out= c i
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in
      [a-zA-Z0-9._~-]) out+=$c ;;
      *) printf -v c '%%%02X' "'$c"; out+=$c ;;
    esac
  done
  printf '%s' "$out"
}

ask() { # ask <key> <what>: a hidden prompt; Enter alone keeps the old value
  local value
  read -rsp "Paste $2, then Enter (Enter alone keeps it): " value
  echo
  [ -n "$value" ] && { set_line "$1" "$value" || true; }
  return 0
}

ask ANTHROPIC_API_KEY 'the reading key (Anthropic console)'
ask S3_ACCESS_KEY_ID 'the file storage access key ID (printed by aws-s3-setup.sh)'
ask S3_SECRET_ACCESS_KEY 'the file storage secret key (printed by aws-s3-setup.sh)'
ask SENTRY_DSN 'the error alerts address (Sentry, project settings, "Client Keys (DSN)")'

# The database: only the password is secret. The host and port are on DigitalOcean's
# "Connection details" page for the database, user `tally`, database `tally`.
read -rsp "Paste the password of the database user tally, then Enter (Enter alone keeps it): " password
echo
if [ -n "$password" ]; then
  read -rp "The database host (Connection details, \"host\"): " host
  read -rp "The database port [25060]: " port
  port=${port:-25060}
  base="postgresql://tally:$(urlencode "$password")@$host:$port/tally"
  # The app's driver and Prisma's migrate engine write TLS settings differently (D60).
  set_line DATABASE_URL "$base?sslmode=verify-full&sslrootcert=/etc/tally/db-ca.pem"
  set_line MIGRATE_DATABASE_URL "$base?sslmode=require&sslcert=/etc/tally/db-ca.pem&sslaccept=strict"
fi
echo "Saved. Keep a copy of each secret in the password manager. Then: cd /opt/tally && docker compose up -d"
