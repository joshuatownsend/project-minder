#!/usr/bin/env bash
# Time API routes cold (first hit) and warm (second hit). Run after `npm run dev` is fresh.

set -uo pipefail
BASE="${BASE:-http://localhost:4100}"

ROUTES=(
  "/api/projects"
  "/api/sessions"
  "/api/usage?period=week"
  "/api/agents"
  "/api/skills"
  "/api/stats"
  "/api/manual-steps"
  "/api/insights"
  "/api/git-status"
)

# Per-run temp file so concurrent runs don't collide
TMP=$(mktemp 2>/dev/null || mktemp -t api-bench)
trap 'rm -f "$TMP"' EXIT

printf '%-32s %10s %10s %10s %6s\n' "Route" "Cold (s)" "Warm (s)" "Bytes" "HTTP"

for r in "${ROUTES[@]}"; do
  # Capture timing AND status code so silent 4xx/5xx don't corrupt the baseline.
  # We don't use --fail because we'd rather record every row than abort on one bad route.
  cold=$(curl -sS -o "$TMP" -w '%{time_total} %{size_download} %{http_code}' "$BASE$r")
  read -r cold_t cold_b cold_code <<< "$cold"

  warm=$(curl -sS -o /dev/null -w '%{time_total} %{http_code}' "$BASE$r")
  read -r warm_t warm_code <<< "$warm"

  flag=""
  if [ "$cold_code" != "200" ] || [ "$warm_code" != "200" ]; then
    flag=" ← FAIL (cold $cold_code, warm $warm_code)"
  fi

  printf '%-32s %10s %10s %10s %6s%s\n' \
    "$r" "$cold_t" "$warm_t" "$cold_b" "$cold_code" "$flag"
done
