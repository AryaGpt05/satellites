#!/usr/bin/env bash
# End-to-end check of the Supabase RPC surface exactly as the browser sees it: PostgREST with the
# publishable key (role `anon`). Reads VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY from
# .env.local. Never prints the key.
#
#   scripts/backend-verify.sh            # read-only + one real lookup + one real share
set -uo pipefail
cd "$(dirname "$0")/.."
REF="${SUPABASE_PROJECT_REF:-}"
if [[ -z "$REF" ]]; then echo "error: set SUPABASE_PROJECT_REF to your Supabase project ref (no default, so this never targets someone else's project)" >&2; exit 2; fi
if [[ ! -f .env.local ]]; then echo "error: .env.local not found (copy .env.example)" >&2; exit 2; fi
set -a; source .env.local; set +a
URL="${VITE_SUPABASE_URL:?missing VITE_SUPABASE_URL}"
KEY="${VITE_SUPABASE_PUBLISHABLE_KEY:?missing VITE_SUPABASE_PUBLISHABLE_KEY}"

pass=0; fail=0
check() { # name, expected-status-regex, actual-status, body
  if [[ "$3" =~ ^($2)$ ]]; then pass=$((pass+1)); printf '  ok   %-44s %s  %s\n' "$1" "$3" "${4:0:160}";
  else fail=$((fail+1)); printf '  FAIL %-44s %s  %s\n' "$1" "$3" "${4:0:300}"; fi
}
rpc() { # fn, json → sets STATUS, BODY
  local out
  out=$(curl -sS -w $'\n%{http_code}' -X POST "$URL/rest/v1/rpc/$1" \
    -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d "$2")
  STATUS="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
get() { # path → STATUS, BODY
  local out
  out=$(curl -sS -w $'\n%{http_code}' "$URL$1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY")
  STATUS="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}

echo "RPCs (anon, publishable key)"
rpc record_lookup '{"p_lat":43.4723,"p_lon":-80.5449,"p_country":"ca","p_label":"Overflight verify"}'
check 'record_lookup valid → 204' '204|200' "$STATUS" "$BODY"
rpc record_lookup '{"p_lat":91,"p_lon":0,"p_country":"ca","p_label":"x"}'
check 'record_lookup lat 91 → 400' '400' "$STATUS" "$BODY"
rpc record_lookup '{"p_lat":"NaN","p_lon":0}'
check 'record_lookup NaN → 400' '400' "$STATUS" "$BODY"

NOW_MS=$(( $(date +%s) * 1000 - 3600 * 1000 ))
SHARE=$(cat <<EOF
{"payload":{"placeLabel":"Overflight verify","lat":43.47231,"lon":-80.54492,"satName":"Sentinel-2C",
 "pass":{"id":"60989-1","norad":60989,"tClosest":$NOW_MS,"tStart":$((NOW_MS-30000)),"tEnd":$((NOW_MS+30000)),
  "groundDistanceKm":12.34567,"offNadirDeg":0.912,"elevationDeg":88.7,"azimuthDeg":271.3,"altitudeKm":786.24,
  "groundSpeedKmS":6.9312,"headingDeg":191.2,"node":"descending","sunElevationDeg":22.4,"inSwath":true,
  "inFieldOfRegard":true,"verdict":"imaged","track":[{"t":1,"lat":2,"lon":3,"altKm":4}]},
 "capture":{"collection":"sentinel-2-l2a","itemId":"S2C_MSIL2A_20261106T161449_R140_T17TNJ_20261106T195148",
  "provider":"planetary-computer","platform":"sentinel-2c","datetime":$NOW_MS,"cloudCoverPct":24.91,"gsdM":10}}}
EOF
)
rpc create_share "$SHARE"
check 'create_share valid → id' '200' "$STATUS" "$BODY"
ID=$(echo "$BODY" | tr -d '"')
[[ "$ID" =~ ^[0-9a-z]{8}$ ]] && check 'share id is 8 chars [0-9a-z]' '.*' ok "$ID" || check 'share id format' 'x' bad "$ID"

rpc get_share "{\"p_id\":\"$ID\"}"
check 'get_share → share json' '200' "$STATUS" "$BODY"
echo "$BODY" | grep -q '"track"' && check 'get_share strips track' 'x' leaked "$BODY" || check 'get_share strips track' '.*' ok ''
echo "$BODY" | grep -Eq '"lat": *43.470?[,}]' && check 'lat rounded to 0.01°' '.*' ok '' || check 'lat rounded to 0.01°' 'x' bad "$BODY"
rpc get_share "{\"p_id\":\"$ID\"}"
echo "$BODY" | grep -q '"views": *2' && check 'get_share counts views' '.*' ok '' || check 'get_share counts views' 'x' bad "$BODY"
rpc get_share "{\"p_id\":\"$ID\",\"p_view\":false}"
echo "$BODY" | grep -q '"views": *2' && check 'get_share p_view=false does not count' '.*' ok '' || check 'p_view=false' 'x' bad "$BODY"
rpc get_share '{"p_id":"zzzzzzzz"}'
check 'get_share unknown → null' '200' "$STATUS" "$BODY"
rpc get_share '{"p_id":"x'"'"'; drop table shares;--"}'
check 'get_share junk id → null' '200' "$STATUS" "$BODY"

BIG=$(python3 -c 'print("{\"payload\":{\"placeLabel\":\"x\",\"lat\":1,\"lon\":1,\"pass\":{\"norad\":1,\"verdict\":\"imaged\",\"tClosest\":1,\"pad\":\"" + "a"*9000 + "\"}}}")')
rpc create_share "$BIG"
check 'create_share > 8 KB → 400' '400' "$STATUS" "$BODY"
LONG=$(python3 -c 'print("{\"payload\":{\"placeLabel\":\"" + "a"*121 + "\",\"lat\":1,\"lon\":1,\"pass\":{\"norad\":1,\"verdict\":\"imaged\",\"tClosest\":'"$NOW_MS"'}}}")')
rpc create_share "$LONG"
check 'create_share label > 120 → 400' '400' "$STATUS" "$BODY"
rpc create_share '{"payload":{"placeLabel":"x","lat":1,"lon":1,"pass":{"norad":1,"verdict":"pwned","tClosest":1}}}'
check 'create_share bad verdict → 400' '400' "$STATUS" "$BODY"

# Implausible numbers are dropped (never stored, never clamped); missing cloud cover stays missing;
# invisible bidi / zero-width characters are stripped from labels.
rpc create_share '{"payload":{"placeLabel":"Overflight‮ verify​","lat":43.47,"lon":-80.54,"pass":{"norad":60989,"verdict":"imaged","tClosest":'"$NOW_MS"',"altitudeKm":1e2000,"headingDeg":99999,"offNadirDeg":-5,"tStart":-1e300,"groundDistanceKm":12},"capture":{"collection":"gibs-viirs-noaa20","itemId":"VIIRS_NOAA20_CorrectedReflectance_TrueColor@2026-11-01","platform":"noaa-20","datetime":'"$NOW_MS"'}}}'
check 'create_share with junk numbers → id' '200' "$STATUS" "$BODY"
JID=$(echo "$BODY" | tr -d '"')
rpc get_share "{\"p_id\":\"$JID\",\"p_view\":false}"
if echo "$BODY" | grep -Eq '"(altitudeKm|headingDeg|offNadirDeg|tStart|cloudCoverPct)"'; then check 'implausible numbers + missing cloud dropped' 'x' leaked "$BODY"
else check 'implausible numbers + missing cloud dropped' '.*' ok "$(echo "$BODY" | head -c 120)"; fi
echo "$BODY" | grep -q '"placeLabel": "Overflight verify"' && check 'bidi / zero-width stripped from label' '.*' ok '' || check 'bidi / zero-width stripped' 'x' bad "$BODY"

rpc get_stats '{}'
check 'get_stats → json' '200' "$STATUS" "$BODY"
echo "$BODY" | grep -q '"total"' && echo "$BODY" | grep -q '"cells"' && check 'get_stats has total + cells' '.*' ok '' || check 'get_stats shape' 'x' bad "$BODY"

echo "Direct table access (must be denied)"
for t in shares lookups lookup_cells lookup_days stats_cache; do
  get "/rest/v1/$t?select=*&limit=1"
  check "GET /rest/v1/$t denied" '401|403|404' "$STATUS" "$BODY"
done
out=$(curl -sS -w $'\n%{http_code}' -X POST "$URL/rest/v1/shares" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"id":"aaaaaaaa","place_label":"x","lat":1,"lon":1}')
check 'POST /rest/v1/shares denied' '401|403|404' "${out##*$'\n'}" "${out%$'\n'*}"
rpc new_share_id '{}'
check 'private helper not exposed' '404' "$STATUS" "$BODY"

echo "Cleanup (Management API; removes only the rows tagged 'Overflight verify')"
CLEAN="delete from public.shares where place_label = 'Overflight verify';
with d as (delete from public.lookups where place_label = 'Overflight verify' returning cell)
update public.lookup_cells c set n = c.n - x.k from (select cell, count(*) k from d group by cell) x where c.cell = x.cell;
delete from public.lookup_cells where n <= 0;
delete from public.lookup_days where label = 'Overflight verify';
delete from public.stats_cache;"
AUTH=()
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then AUTH=(-H "authorization: Bearer ${SUPABASE_ACCESS_TOKEN}"); fi
python3 -c 'import json,sys; sys.stdout.write(json.dumps({"query": sys.argv[1]}))' "$CLEAN" |
  curl -sS -X POST "https://api.supabase.com/v1/projects/${REF}/database/query" -H 'content-type: application/json' \
    "${AUTH[@]}" --data-binary @- >/dev/null && echo "  cleaned" || echo "  cleanup skipped (no management access)"

echo "passed $pass, failed $fail"
[[ $fail -eq 0 ]]
