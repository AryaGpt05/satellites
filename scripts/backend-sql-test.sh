#!/usr/bin/env bash
# Run a migration's SQL checks against the real database inside ONE transaction that is rolled back:
#   begin; <migration>; <supabase/tests/<name>.test.sql>; rollback;
# Nothing it writes survives. A failed check raises, so the API call fails and this exits non-zero.
#
#   scripts/backend-sql-test.sh                         # every supabase/tests/*.test.sql
#   scripts/backend-sql-test.sh 0004_events_admin       # one
# Auth: the Management API token comes from the environment's proxy, or SUPABASE_ACCESS_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."
REF="${SUPABASE_PROJECT_REF:-etiebfmgepkcewkkbxwi}"
AUTH=()
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then AUTH=(-H "authorization: Bearer ${SUPABASE_ACCESS_TOKEN}"); fi

names=("$@")
if [[ ${#names[@]} -eq 0 ]]; then for t in supabase/tests/*.test.sql; do names+=("$(basename "$t" .test.sql)"); done; fi

status=0
for name in "${names[@]}"; do
  echo "→ ${name} (rolled back)"
  out=$(python3 -c '
import json, sys
mig, test = (open(p).read() for p in sys.argv[1:3])
sys.stdout.write(json.dumps({"query": "begin;\n" + mig + "\n" + test + "\nrollback;\n"}))' \
    "supabase/migrations/${name}.sql" "supabase/tests/${name}.test.sql" |
    curl -sS -w $'\n%{http_code}' -X POST "https://api.supabase.com/v1/projects/${REF}/database/query" \
      -H 'content-type: application/json' "${AUTH[@]}" --data-binary @-)
  code="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [[ "$code" =~ ^2 ]] && ! grep -q '"error"\|"message"' <<<"$body"; then echo "  ok   ${body:0:200}"
  else echo "  FAIL ${code} ${body:0:1200}"; status=1; fi
done
exit $status
