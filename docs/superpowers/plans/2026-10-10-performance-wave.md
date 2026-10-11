# Performance wave — tray CPU/memory (2026-10-10)

Covers the open performance issues: #654, #656, #655, #584 (server half), #657, #627.
Every code citation below was re-checked against `main` @ `a567a444` on 2026-10-10.

## Symptom being fixed

Packaged tray server sits at ~1 CPU core and grows 350 MB → 1.8 GB in ~18 min with
6 active Claude sessions (#654). Corpus: 15,109 JSONL files / 10,526 session dirs / 7.3 GB.

## Measurement gate (applies to every wave)

The issue numbers are one machine's observations. Capture a baseline before each wave and the
same numbers after it, on the same corpus with 3+ active sessions:

- CPU-seconds consumed by the server over a fixed 10-min window (`Get-Process` `CPU` delta).
- Working set at 0 / 10 / 20 min.
- `MINDER_PROFILE_INGEST=1` (exists: `src/lib/db/ingest.ts`, `PROFILE` const) for per-phase
  reconcile timings.

A wave is "done" only with before/after numbers in its PR description.

## Wave 1 — #654 straddle-PR recovery on almost every tool call (primary driver)

**Confirmed.** `parseJsonlTail` sets `hasOrphanToolResults` whenever a tail's `tool_result`
references a `tool_use_id` outside the tail. `tool_use` and `tool_result` are normally written in
separate appends, so this fires on nearly every tool call. `reconcileSessionFile` then calls
`recoverStraddledPrs`, which reads, splits and `JSON.parse`s the **whole** file (up to 50 MB).

**Fix — content gate (recommended):** only flag an orphan when the orphan `tool_result`'s
text matches `PR_URL_RE` (`src/lib/usage/prExtractor.ts`). A straddled `gh pr create` can only
yield a PR if its result contains a `github.com/<o>/<r>/pull/<n>` URL, so the gate loses no
recoveries and skips ~all of the work. Export the regex (or a `textMayContainPrUrl()` helper)
from `prExtractor.ts` rather than duplicating it.

Alternative/extra: resolve the orphan `tool_use_id` against the already-ingested `tool_uses`
rows and only recover when that row is a Bash `gh pr create`. More precise, more code;
not needed if the gate alone hits the target.

Tests: tail with an orphan non-PR result → no full-file read (spy `fs.readFile`); tail with an
orphan result containing a PR URL → PR recovered (existing straddle test stays green). Mutate
the gate to `true` and confirm the first test fails.

## Wave 2 — #656 memory ceiling (can ship with Wave 1)

**Confirmed in code, premise corrected by measurement.** `src/lib/db/workerHost.ts`
`new Worker(entry, {...})` had no `resourceLimits`; `src/lib/db/connection.ts` set
`mmap_size = 256 MB` on both the main and worker connections (the worker bundles
`ingestWatcher.ts` and opens through the same `getDb()`).

But `~/.minder/logs/minder.log` hourly memory samples (734 samples, through 2026-10-11) show the
**worker is not where the memory is**: worker heapUsed p50 113 MB / p90 245 MB, every sample
since 2026-09-26 < 400 MB (a run of 1–2.6 GB samples 2026-09-17…26 predates that). The main
thread heap sits at 1.4–1.9 GB (see Wave 5). So the straddle recovery (which runs in the
worker) explains #654's CPU, not its RSS.

- `resourceLimits: { maxOldGenerationSizeMb: 1024 }` — a runaway guard at ~2.5× the recent max,
  not 512 (a cap that fires >5×/hour exhausts `MAX_RESPAWNS_PER_HOUR` and hands ingest to the
  in-process watcher, which is uncapped — strictly worse). Verified empirically that an OOM
  worker emits `error` with `ERR_WORKER_OUT_OF_MEMORY` then exits 1 → the existing
  crash/respawn path. That `error` is now logged as its own cause.
- Worker-connection `mmap_size` → 64 MB; main and read-only connections unchanged.
- Worker `heapUsed` in the hourly memory line: already shipped (#561).
- **Known hole (Wave 3):** crash-budget fallback runs ingest on the main thread with no ceiling.

## Wave 5 — main-thread heap 1.4–1.9 GB (new, unfiled)

Main heap in the hourly samples: 1.4–1.9 GB used, with dips to 350–740 MB (so collectable/
retained, not a hard leak). Source unknown — **profile before fixing**: take a heap snapshot of
the live tray server via the inspector recipe in memory note
`project_tray_memory_exhaustion_2026_09` (`process._debugProcess`), and diff two snapshots an
hour apart. Candidates to check, not assume: Agent View `liveCostCache` re-parses (#657, main
thread), the usage/sessions 2-min parse caches, scan cache.

## Baseline (before Waves 1–2), tray build 1.16.10

From `minder.log` memory samples, last instance (uptime 0 → 25.5 h): RSS 733 MB at 7 min,
1.6–2.3 GB thereafter; main heap 1.0–1.97 GB; worker heap 11–400 MB. CPU per #654: 0.67–1.35
cores sampled. After-numbers come from the same log line once the build is installed.

## After Waves 1–2 (= Wave 3 baseline), tray build 1.16.11

`Get-Process` on the tray server, sampled each minute from boot (2026-10-11, 06:34 local):
- Boot (0–7 min): ~470 CPU-s — initial reconcile + scan, expected.
- Steady state (8–21 min): 223 CPU-s over 13 min ≈ **0.29 cores**, down from 0.67–1.35. Wave 1 landed.
- Working set: 325 MB at 3 min → **1.64 GB by 8 min**, then flat to 21 min. The main-thread
  memory is a boot-time fill, not slow growth — a pointer for Wave 5's profile, not a conclusion.

## Wave 3 — #655 30 s safety sweep + #584 server half

**Confirmed.**
- `SWEEP_INTERVAL_MS = 30_000` in `src/lib/db/ingestWatcher.ts`, no knob.
- Double walk: `runReconcileAllSessions` calls `discoverAllSessions(config)` (which runs every
  enabled adapter **including Claude**) and then `.filter((f) => f.source !== "claude")`.
- `reconcileSessionFile` prepares its statements per call (two `db.prepare` in its body).

Fixes:
1. Add an `exclude` (or "non-Claude only") option to `discoverAllSessions` in
   `src/lib/adapters/index.ts` so Claude's `discover()` never runs on this path.
2. Hoist/cached-prepare the per-file statements (a `WeakMap<Database, Statements>` keeps it
   test-friendly).
3. When `watcherMode === "native"`, stretch the sweep to 5 min; keep 30 s for chokidar/
   polling/sweep-only. Add `MINDER_SWEEP_INTERVAL_MS` override.

**#584:** the tray half shipped in #587 (`PROBE_TIMEOUT` now 10 s, busy ≠ dead) and #609
(health answers after DB probe). The remaining server half — event loop degraded ~15 min
after boot — is the same cost center as this wave. After Waves 1+3 land, re-measure a cold
boot (`minder.log` boot timings) and close #584 if the window is gone, or re-scope it with the
new profile numbers.

## Wave 4 — #657 Agent View lifecycle

**Confirmed.** `src/app/api/agent-view/stream/route.ts` starts `startJobRosterWatcher()` and
`startJsonlWatcher()` (second recursive `fs.watch` on the projects dir; 5 s `setInterval`) and
never stops them. `liveCostCache.ts` keys on mtime, so an actively written session re-parses
its whole file on every event.

Fixes:
1. Ref-count SSE subscribers; at 0 (after ~30 s grace) close the jsonl watcher and clear the
   roster interval. Restart on the next subscriber.
2. Live cost: read the session's summed cost and latest context fill from the index when the
   DB is ready; fall back to the current parse only for the debounce gap / DB-off mode.
   (Alternative: tail from last byte offset like ingest does.)
3. Evict cache entries for ended/idle sessions.

**Implemented (branch `perf/wave4-agent-view-657`):**
- `agentViewWatchers.ts` ref-counts SSE subscribers; 30 s grace; both watchers abortable
  (AbortController created synchronously, so a stop before `fs.access` resolves still cancels).
  The one-shot `/api/agent-view` route only refreshes the roster.
- Live cost/fill from the index (`data/indexedLiveMetrics.ts`): `sessions.cost_usd` (primary-only,
  same as the parse) and the last primary assistant turn's raw tokens, run through the parse
  path's own fill formula (`turns.context_fill` is a different formula — not used). Parse only
  when the index is off or has no row. Josh approved the ~1–2 s chip lag (2026-10-11).
- Found while building it: ingest's post-commit events fired on the **worker's** buses, so
  `/api/events` never got `sessions.changed` and Agent View never heard the index caught up.
  The worker now relays them (`forwardIngestEvents`), `workerHost` re-emits validated copies.
- `pruneLiveMetricsCache` keeps only sessions the latest snapshot enriched.

## Deferred

- **#627** prompts_fts full scan on session rewrite (~2 s each). Its own assessment: low
  frequency, not urgent. Revisit only if Wave 1–3 profiles show `writeSession` pre-deletes.

## Other open issues (not performance)

- **#664** MCP usage tools, `/api/usage/compare` and group Costs still key on the lossy usage
  slug — direct follow-up to #639 (just merged); natural next correctness item.
- **#660** Config → MCP tab doesn't refetch after a manual security scan (5 s reader cache).
- **#649** `/api/pulse` notification drains should be ack-based, not destructive-on-read.
- **#652** flaky `fileLockReentrant` timing test on Windows CI.
- **#553** catalog home dimension — claude-config half still open.
- Parked: #432 (Next 16.3.0 miscompile gate), #231, #230, #229, #228.

## Sequencing

| Wave | Issues | Size | Ships as |
|---|---|---|---|
| 1 | #654 | S | PR A (with Wave 2) |
| 2 | #656 | S | PR A |
| 3 | #655, #584 | M | PR B |
| 4 | #657 | M | PR C |
| 5 | main-thread heap | ? | profile first |
| — | #627 | — | deferred |

Each PR: `/simplify` pass, typecheck + full suite + `pnpm build`, `/pr-resolve` to convergence,
CHANGELOG entry (behavior change: CPU/memory, sweep interval knob).
