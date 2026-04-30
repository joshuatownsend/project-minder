#!/usr/bin/env bash
# Time API routes cold (first hit) and warm (second hit). Run after `npm run dev` is fresh.

set -u
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

# Print header
printf '%-32s %10s %10s %10s\n' "Route" "Cold (s)" "Warm (s)" "Bytes"

for r in "${ROUTES[@]}"; do
  # Cold: first hit (TTL window flushed for that route since last touch)
  cold=$(curl -s -o /tmp/api-bench-out -w '%{time_total} %{size_download}' "$BASE$r")
  cold_t=$(echo "$cold" | awk '{print $1}')
  cold_b=$(echo "$cold" | awk '{print $2}')

  # Warm: same request immediately
  warm=$(curl -s -o /dev/null -w '%{time_total}' "$BASE$r")

  printf '%-32s %10s %10s %10s\n' "$r" "$cold_t" "$warm" "$cold_b"
done
