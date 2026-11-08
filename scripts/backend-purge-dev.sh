#!/usr/bin/env bash
# Remove development rows from the Overflight database (Management API; see backend-migrate.sh).
#
#   scripts/backend-purge-dev.sh              rows written by ?sandbox=backend and backend-verify.sh,
#                                             tagged by label ("… (sandbox)", "Overflight sandbox",
#                                             "Overflight verify"); nothing else is touched
#   scripts/backend-purge-dev.sh --all --yes  EVERYTHING (all lookups, shares, stats): run once
#                                             before launch, since dev servers share this database
set -euo pipefail
REF="${SUPABASE_PROJECT_REF:-etiebfmgepkcewkkbxwi}"
AUTH=()
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then AUTH=(-H "authorization: Bearer ${SUPABASE_ACCESS_TOKEN}"); fi

SQL="with s as (
  delete from public.shares where place_label like '% (sandbox)' or place_label = 'Overflight verify' returning 1
), d as (
  delete from public.lookups where place_label in ('Overflight sandbox', 'Overflight verify') returning cell
), c as (
  update public.lookup_cells lc set n = lc.n - x.k
  from (select cell, count(*) k from d group by cell) x where lc.cell = x.cell returning 1
)
select (select count(*) from s) as shares_deleted, (select count(*) from d) as lookups_deleted;
delete from public.lookup_cells where n <= 0;
delete from public.lookup_days where label in ('Overflight sandbox', 'Overflight verify');
delete from public.stats_cache;
select (select count(*) from public.shares) as shares_left, (select count(*) from public.lookups) as lookups_left;"

if [[ "${1:-}" == "--all" ]]; then
  if [[ "${2:-}" != "--yes" ]]; then echo "refusing: --all deletes every lookup and share; pass --all --yes" >&2; exit 2; fi
  SQL="truncate public.lookups, public.lookup_cells, public.lookup_days, public.shares, public.stats_cache restart identity;
select (select count(*) from public.shares) as shares_left, (select count(*) from public.lookups) as lookups_left;"
fi

python3 -c 'import json,sys; sys.stdout.write(json.dumps({"query": sys.argv[1]}))' "$SQL" |
  curl -sS --fail-with-body -X POST "https://api.supabase.com/v1/projects/${REF}/database/query" \
    -H 'content-type: application/json' "${AUTH[@]}" --data-binary @-
echo
