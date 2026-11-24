#!/bin/bash
# Makes the user `tally` the owner of the database `tally` (T4.3, D60). Postgres 15 and later let
# only the owner create tables, which the migrations need. Run once on the server, after the user
# and the database are created in DigitalOcean's control panel:
#   sudo bash /opt/tally/db-owner.sh
# It asks for the admin (doadmin) connection string, from the database's "Connection details"
# (user doadmin, "Connection string"). What you paste is not shown and is not kept anywhere.
set -euo pipefail
read -rsp "Paste the doadmin connection string, then Enter: " url
echo
[ -n "$url" ] || { echo "Nothing pasted; nothing changed."; exit 1; }
# Handed to the container on its input, never on a command line others could see.
printf '%s\n' "$url" | docker run --rm -i postgres:16.16-alpine \
  sh -c 'read -r PGURL; psql "$PGURL" -v ON_ERROR_STOP=1 -c "ALTER DATABASE tally OWNER TO tally"'
echo "Done: the user tally owns the database tally."
