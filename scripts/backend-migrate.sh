#!/usr/bin/env bash
# Apply supabase/migrations/*.sql (in order) through the Supabase Management API.
# Every migration is idempotent, so re-running is safe.
#
#   SUPABASE_ACCESS_TOKEN=… scripts/backend-migrate.sh          # personal access token
#   SUPABASE_PROJECT_REF=…  (defaults to the Overflight project)
#
# The token is passed in a header and never echoed.
set -euo pipefail
cd "$(dirname "$0")/.."

REF="${SUPABASE_PROJECT_REF:-etiebfmgepkcewkkbxwi}"
AUTH=()
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then AUTH=(-H "authorization: Bearer ${SUPABASE_ACCESS_TOKEN}"); fi

for f in supabase/migrations/*.sql; do
  echo "→ applying ${f}"
  python3 -c 'import json, sys; sys.stdout.write(json.dumps({"query": open(sys.argv[1]).read()}))' "$f" |
    curl -sS --fail-with-body -X POST "https://api.supabase.com/v1/projects/${REF}/database/query" \
      -H 'content-type: application/json' "${AUTH[@]}" --data-binary @-
  echo
done
