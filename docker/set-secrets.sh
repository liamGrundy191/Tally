#!/bin/bash
# Puts the secret settings into /opt/tally/.env without them ever passing through chat, email or
# GitHub (T4.3, D60). Run it on the server, for example from DigitalOcean's web console:
#   sudo bash /opt/tally/set-secrets.sh
# It asks for each secret in turn; what you paste is not shown. Press Enter to keep a value as it
# is. Every other line of the file is left alone.
set -euo pipefail
file=/opt/tally/.env
secrets=(
  'ANTHROPIC_API_KEY|the reading key (Anthropic console)'
  'S3_ACCESS_KEY_ID|the file storage access key ID (printed by aws-s3-setup.sh)'
  'S3_SECRET_ACCESS_KEY|the file storage secret key (printed by aws-s3-setup.sh)'
  'DATABASE_URL|the database address for the app (ends with sslmode=verify-full&sslrootcert=/etc/tally/db-ca.pem)'
  'MIGRATE_DATABASE_URL|the database address for migrations (ends with sslmode=require&sslcert=/etc/tally/db-ca.pem&sslaccept=strict)'
  'SENTRY_DSN|the error alerts address (Sentry project settings, "Client Keys (DSN)")'
)
for entry in "${secrets[@]}"; do
  key=${entry%%|*}
  read -rsp "Paste ${entry#*|}, then Enter (Enter alone keeps it): " value
  echo
  [ -z "$value" ] && continue
  tmp=$(mktemp "$file.XXXX")
  grep -v "^$key=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod 600 "$tmp"
  chown --reference="$file" "$tmp"
  mv "$tmp" "$file"
done
echo "Saved. Keep a copy of each secret in the password manager, then restart: cd /opt/tally && docker compose up -d"
