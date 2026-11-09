#!/usr/bin/env bash
# Add an email to the admin list (overflight_private.admins), which gates /admin and admin_stats.
# Admin addresses are kept out of the repo on purpose: run this once against your own project.
# The person must also sign in once at /admin with that email (magic link) and confirm it.
#
#   SUPABASE_PROJECT_REF=<ref> SUPABASE_ACCESS_TOKEN=… scripts/backend-set-admin.sh you@example.com
#
# Additive and idempotent: it never removes existing admins. The token is never echoed.
set -euo pipefail
REF="${SUPABASE_PROJECT_REF:-}"
if [[ -z "$REF" ]]; then echo "error: set SUPABASE_PROJECT_REF to your Supabase project ref (no default, so this never targets someone else's project)" >&2; exit 2; fi
EMAIL="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
if [[ ! "$EMAIL" =~ ^[^@[:space:]\']+@[^@[:space:]\']+\.[^@[:space:]\']+$ ]]; then
  echo "usage: SUPABASE_PROJECT_REF=<ref> $0 <email>" >&2; exit 2
fi
AUTH=()
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then AUTH=(-H "authorization: Bearer ${SUPABASE_ACCESS_TOKEN}"); fi

echo "→ project ${REF}: adding ${EMAIL} to overflight_private.admins (existing admins are kept)"
SQL="insert into overflight_private.admins (email) values ('${EMAIL}') on conflict do nothing;
select email from overflight_private.admins order by email;"
python3 -c 'import json,sys; sys.stdout.write(json.dumps({"query": sys.argv[1]}))' "$SQL" |
  curl -sS --fail-with-body -X POST "https://api.supabase.com/v1/projects/${REF}/database/query" \
    -H 'content-type: application/json' "${AUTH[@]}" --data-binary @-
echo
