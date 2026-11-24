#!/bin/sh
# Fails if a built image holds a file that must never leave this computer (T4.3, D60): secrets
# (.env), real names (names.txt, workplaces.txt, truth.csv), scans or any picture or PDF (the
# images hold none of their own outside installed packages), the test fixtures, tools, docs,
# git or Claude files.
# Usage: docker/scan-image.sh <image> <folder in the image>, e.g. tally-app:ci /app
set -eu
found=$(docker run --rm --user 0 --entrypoint sh "$1" -c "
  find '$2' -path '*/node_modules' -prune -o \\( -name names.txt -o -name workplaces.txt \
    -o -name truth.csv -o -name '*.csv' -o -name '.env' -o -name '.env.*' -o -name scan-output \
    -o -name fixtures -o -name '.claude' -o -name CLAUDE.md -o -name '.git' \
    -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.pdf' \\) -print
  for d in tools docs; do [ -e '$2'/\$d ] && echo '$2'/\$d; done; true")
if [ -n "$found" ]; then
  echo "$1 must not contain:"
  echo "$found"
  exit 1
fi
echo "$1: no private files"
