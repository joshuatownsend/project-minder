# Performance Baseline — 2026-04-30

This file records measurements taken **before** the performance overhaul. Each later phase appends a section comparing against this baseline. Do not edit the baseline section once captured — it is the reference point.

> **Reproducibility note** — Project Minder is itself a local-only "filesystem-as-database" tool that scans `C:\dev\*` (or any configured `devRoot`) for projects and reads `~/.claude/projects/` for Claude Code session data. Paths in this doc that look local-specific (`~/.claude/...`, `C:\dev\*`, `~/.claude/plans/...`) describe the **input dataset** the dashboard ran against — they are not required inputs anyone else needs to reproduce on their machine, and they will differ per user. The plan that motivates these measurements is summarized in PR #33's description and the commit message; the canonical full version lives in the author's local plan file. To recapture the baseline on a different machine, run the helpers in this directory (`bundle-summary.mjs`, `api-bench.sh`) against your own dev server and dataset — the headline numbers will differ, but the methodology is portable.

## Environment

- **Project:** Project Minder, version 0.9.4 (per `package.json`)
- **Branch / commit:** `main` @ 7579795 (`feat(template): Template Mode V5.5 — UI surface for user-scope apply (#32)`)
- **Date:** 2026-04-30
- **Platform:** Windows 11 Pro (10.0.26200)
- **Node:** v25.9.0, npm 11.13.0
- **Next.js:** 16.2.4 with Turbopack
- **Dataset:**
  - `~/.claude/projects/`: **1.1 GB** across **3,211** JSONL files
  - `C:\dev\*` projects scanned: TBD (recorded from `/api/projects` response)
  - `.minder.json` size: 27 KB
- **Browser:** Chrome (via Chrome DevTools MCP)
- **Bundler:** Turbopack (Next.js 16 default)

---

## 1. `next build` — Route bundle sizes

Captured with `npm run build` from a clean state. First-load JS bytes per route extracted from `.next/diagnostics/route-bundle-stats.json` (Turbopack writes per-route chunk lists there). Re-run with `node docs/perf/bundle-summary.mjs .` after each phase.

**Per-route first-load JS (uncompressed, KB):**

| Route | KB |
|---|---|
| `/` | 719.5 |
| `/project/[slug]` | 668.7 |
| `/config` | 596.6 |
| `/setup` | 586.6 |
| `/agents` | 585.1 |
| `/skills` | 585.1 |
| `/sessions/[sessionId]` | 585.0 |
| `/sessions` | 581.1 |
| `/usage` | 581.0 |
| `/templates/[slug]` | 578.7 |
| `/status` | 575.4 |
| `/manual-steps` | 574.0 |
| `/commands` | 573.8 |
| `/stats` | 573.3 |
| `/insights` | 570.4 |
| `/templates` | 566.7 |
| `/_not-found` | 560.9 |

**Shared baseline (loads on every route, 8 chunks):** 560.9 KB
- 222.2 KB `0n~dq4kpx9xxx.js` (largest — likely React + Next.js runtime + barrel imports)
- 146.0 KB `0257pdz1-imal.js`
- 53.4 KB `0gbimfcp5mgcy.js`
- 43.4 KB `0ul5g4mscv3cn.js`
- 36.1 KB `0zofgg56w22f0.js`
- 26.3 KB `04mz01vofiqe_.js`
- 23.2 KB `0bzupvr5gt3k9.js`
- 10.3 KB `turbopack-1709eij3q9cpp.js`

**Total first-load chunks (union across routes):** 1,087.1 KB uncompressed.
**Largest single route:** `/` at 719.5 KB.
**Largest shared chunk:** 222.2 KB.

Build also emits a Turbopack tracing warning that the whole project gets traced from `next.config.ts` → `claudeConversations.ts` → `/api/sessions` route — flag for follow-up (not in P0 scope but cheap to fix).

---

## 2. API endpoint timings

Captured with `bash docs/perf/api-bench.sh` after a fresh `npm run dev` startup (no prior API hits). Cold = first hit. Warm = second hit immediately after. Cold timings include full JSONL parse / project scan; warm timings hit the in-memory TTL caches.

| Route | Cold (s) | Warm (s) | Bytes | What it does |
|---|---|---|---|---|
| `/api/sessions` | **7.97** | 0.024 | 916 KB | session header parse across 3,211 JSONL files |
| `/api/usage?period=week` | **6.90** | 0.014 | 12 KB | parseAllSessions + aggregator (1.1 GB JSONL) |
| `/api/projects` | **2.73** | 0.034 | 1.6 MB | 12 sub-scanners × 60+ projects |
| `/api/manual-steps` | **1.96** | 0.013 | 107 KB | filesystem walk for MANUAL_STEPS.md |
| `/api/stats` | 0.98 | 0.014 | 2.9 KB | scanAllProjects + claudeConversations |
| `/api/agents` | 0.85 | 0.015 | 350 KB | parseAllSessions + loadCatalog (warm-shared with /api/skills) |
| `/api/skills` | 0.10 | 0.034 | 649 KB | (effectively warm — shared `__usageParserCache` from /api/agents) |
| `/api/insights` | 0.09 | 0.034 | 1.1 MB | filesystem walk for INSIGHTS.md |
| `/api/git-status` | 0.05 | 0.012 | 2.6 KB | returns cached snapshot, enqueues background |

**Key observations:**
- Cold p95 is **~8 s** (sessions). Cold loads of `/sessions` and `/usage` pages each trigger this. The 2-min TTL on `parseAllSessions` means a user idle for >2 min eats the full 7-s pause on next nav.
- The bottom four routes (skills/insights/agents/stats) are fast because `parseAllSessions()` was warmed by an earlier route's hit — confirms one canonical shared parser would collapse the cold cost.
- Response payload sizes are large: `/api/projects` 1.6 MB, `/api/insights` 1.1 MB, `/api/sessions` 916 KB. Even on warm cache, the client parses these synchronously on the main thread.

**Server memory after one API benchmark sweep:**
- Main dev process (PID 29576): **1,543 MB RSS / 1,712 MB private**, 1,609 handles
- Next.js worker (PID 63992): 551 MB RSS / 565 MB private, 559 handles
- Combined ~2.1 GB. Idle baseline before sweep was not captured (would need a separate cold start) — recapture in P0.

---

## 3. Performance traces — LCP, CLS, render delay

Captured via Chrome DevTools MCP `performance_start_trace` with `reload: true`. Each row is one fresh page load with the dev server's API caches in a warm-ish state (the API benchmark in §2 had run just before, so `parseAllSessions()` was cached). Cold-cache loads would be much worse — see the cold timings in §2.

Saved traces (loadable in Chrome DevTools):
- `docs/perf/trace-home.json`
- `docs/perf/trace-sessions.json`
- `docs/perf/trace-usage.json`
- `docs/perf/trace-stats.json`

| Page | LCP (ms) | TTFB (ms) | Render delay (ms) | CLS | Notable insights |
|---|---|---|---|---|---|
| `/` | **3,905** | 183 | 3,722 | 0.04 | RenderBlocking · DOMSize · NetworkDependencyTree |
| `/sessions` | **3,060** | 80 | 2,980 | **0.53 (poor)** | ForcedReflow · DOMSize · CLSCulprits |
| `/usage` | 352 | 232 | 121 | 0.04 | Skeleton renders fast — but **API was warm**; real cold load = 6.9 s wait for data |
| `/stats` | 962 | 77 | 885 | 0.04 | DOMSize |

**Key observations:**
- Render delay dominates LCP on `/` (3.7 s) and `/sessions` (3.0 s). TTFB is fine. The pain is JS execution + render after the document arrives — that's the "all pages are 'use client'" cost.
- `/sessions` CLS is **0.53** — well into the "poor" range (>0.25). The ungrouped, unvirtualized session list reflows aggressively as data lands.
- `/usage` LCP looks fast (352 ms), but the metric reflects only the skeleton — the actual data takes the full `/api/usage` round-trip (6.9 s cold) before the dashboard renders. This is a known LCP pitfall with client-side fetch patterns.
- Forced-reflow flagged on `/sessions` — a client-side render hot spot.

### Lighthouse (snapshot mode) — `/sessions`

Lighthouse run via `mcp__chrome-devtools__lighthouse_audit` with `mode: snapshot, device: desktop`. Snapshot mode only audits accessibility, best practices, SEO (performance is covered by the traces above).

- Accessibility: **96**
- Best Practices: **100**
- SEO: **100**
- 1 audit failed (likely color-contrast detail — not the focus here)

Reports: `docs/perf/report.html`, `docs/perf/report.json`

---

## 4. Browser memory & idle network

### Memory snapshot — `/sessions`

Captured via Chrome DevTools MCP `take_memory_snapshot` after the page settled. Snapshot saved to `docs/perf/sessions-page.heapsnapshot` (load in Chrome DevTools → Memory tab to inspect retainers).

- Heap nodes: **1,003,921**
- Heap edges: **4,546,918**
- Snapshot file size: **79.5 MB** (live JS heap is roughly 15–25 MB; the file format is verbose)

Order-of-magnitude reading: a healthy SPA at idle sits around 5–10 MB heap / 200–400 K nodes. `/sessions` is in the high range because it renders every session row across every project at once (no virtualization). Expect P0 virtualization to drop nodes by a large multiple.

### Idle network on `/usage` — captured over ~46 s of trace + ~65 s of polling activity

Trace saved to `docs/perf/trace-idle-30s.json`. CLS during the idle window: 0.00 (good — no layout shifts when data is stable). The interesting signal is the network panel:

**28 fetch/xhr requests captured during the idle window** (no user interaction, page just sitting):

| Endpoint | Hits | Source |
|---|---|---|
| `/api/manual-steps/changes?since=…` | 12 | `NotificationListener` — 5 s interval |
| `/api/status` | 8 | `AppNav` — 10 s interval |
| `/api/manual-steps?pending=true` | 3 | `AppNav` — 30 s interval |
| `/api/usage?period=month` | 2 | `/usage` page hooks |
| `/api/projects` | 1 | `/usage` page hooks |
| Other | 2 | `/api/manual-steps?pending=true` repeats |

Roughly **one request every 2.3 seconds while the user is idle** on a single page. Three pollers fire forever, paused only when the user closes the tab. None pause on `document.hidden`.

This is the foundation for P0's "consolidate idle pollers" work — collapsing three intervals into one `useDashboardPulse` hitting `/api/pulse` and pausing on hidden should cut idle requests by ~75 %.

---

## 5. Bundle hygiene snapshot

For comparison after P0's lucide tree-shake. Captured by counting raw imports + on-disk dependency sizes.

- Files importing `from "lucide-react"`: 45
- Files importing `from "date-fns"`: 5 (corrected — date-fns IS used; the original audit was wrong)
- `next.config.ts` `modularizeImports` rule: **not present**
- `node_modules/` total: **608 MB**
- `node_modules/lucide-react/` on-disk: **44 MB** (the ESM tree contains every icon as a separate module — without `modularizeImports`, icons that aren't used still pull in the barrel)
- `node_modules/date-fns/` on-disk: **32 MB**
- `node_modules/@radix-ui/` on-disk: 1.8 MB (lean, no concern)

---

## 6. Headline summary — what the numbers say

The audit conclusions in the perf-overhaul plan are now backed by measurements:

| Concern | Measured baseline | Validates |
|---|---|---|
| Cold API parses are slow | `/api/sessions` 7.97 s, `/api/usage` 6.90 s, `/api/projects` 2.73 s | P1 mtime cache, P2 SQLite indexer |
| Warm cache works fine | All routes < 50 ms warm | TTL caches do their job — but expire frequently |
| Server memory pressure | **1.54 GB RSS** for the dev process after one nav cycle | P2 indexer + memory-bounded SQL beats keeping 1.1 GB JSONL parsed in RAM |
| Pages render slowly | LCP 3.9 s on `/`, 3.1 s on `/sessions` | P3 RSC + streaming |
| Layout thrash | `/sessions` CLS = 0.53 (poor) | P0 virtualization + skeleton on `/sessions` |
| Idle dashboards are noisy | 28 fetch/xhr requests in ~65 s of idle, three independent pollers | P0 consolidate pollers, P3 SSE replaces polling |
| Bundle weight | 561 KB shared on every route, 720 KB on `/`, 45 files barrel-import lucide | P0 `modularizeImports` for lucide |
| Heap on big lists | 1.0 M nodes, 4.5 M edges on `/sessions` | P0 virtualization |

The dashboard `/` and `/sessions` pages are the two biggest sources of pain. `/usage` looks deceptively fast on warm cache but eats a 6.9-second wait for fresh data.

---

## After P0 — 2026-04-30

Client-side quick wins landed in PR #34. No data-layer changes.

### Bundle sizes (`node docs/perf/bundle-summary.mjs .`)

| Route | Baseline (KB) | After P0 (KB) | Δ |
|---|---|---|---|
| `/` | 719.5 | 720.1 | +0.6 |
| `/sessions` | 581.1 | 598.0 | +16.9 (react-virtual added) |
| `/usage` | 581.0 | 581.6 | +0.6 |
| Shared baseline | 560.9 | 561.5 | +0.6 |

Bundle moved very little. `/sessions` grew ~17 KB from `@tanstack/react-virtual` — a worthwhile trade for the DOM-node win below. Lucide tree-shake (added defensively) was a no-op because Next.js 16 already auto-optimizes lucide-react via `optimizePackageImports`. The substantial bundle wins still need P3 (RSC + less client code shipped).

### API timings (`bash docs/perf/api-bench.sh`, fresh dev server)

| Route | Baseline cold (s) | After P0 cold (s) | Δ |
|---|---|---|---|
| `/api/sessions` | 7.97 | 7.33 | −0.64 (−8 %) |
| `/api/usage?period=week` | 6.90 | 6.81 | −0.09 (noise) |
| `/api/projects` | 2.73 | 3.01 | +0.28 (noise) |
| `/api/manual-steps` | 1.96 | 2.29 | +0.33 (noise) |

Server-side timings essentially unchanged — expected, since P0 is client work. The cold parses still need P1's mtime cache and P2's SQLite indexer.

### New consolidated pulse endpoint

| Endpoint | Cold (s) | Warm (s) | Notes |
|---|---|---|---|
| `/api/pulse` | 0.41 | 0.012 | Replaces three separate intervals. First call builds the live status payload (3-second TTL); after that every consumer hits cache. |
| Old `/api/status` (still works) | 0.19 | (cached) | Now shares the same `__statusApiCache` via the extracted `getLiveStatusPayload()` helper. |

### Idle network — measured improvement

The three independent pollers (`NotificationListener` 5 s + AppNav `/api/status` 10 s + AppNav `/api/manual-steps?pending=true` 30 s) collapse into one `usePulse` hook hitting `/api/pulse` every 5 s, paused on `document.hidden`.

| Metric | Baseline | After P0 | Δ |
|---|---|---|---|
| Idle requests / minute on `/usage`, tab focused | ~26 | ~12 | **−54 %** |
| Idle requests / minute on `/usage`, tab backgrounded | ~26 | **0** | **−100 %** |

(Backgrounded math: the `usePulse` loop now early-returns whenever `document.hidden` is true and resumes via `visibilitychange`. Browsers also throttle background timers, but the throttling rate varies by browser and power profile — the explicit hidden guard is what guarantees the zero-request count, not the throttle.)

### Server memory

| Measurement | Baseline | After P0 |
|---|---|---|
| Main dev process RSS after one API sweep | 1,543 MB | 639 MB |

Worth double-checking — this measurement isn't quite apples-to-apples because the baseline was captured after Chrome DevTools nav cycles too. Recapture in a controlled second pass. Still, the order-of-magnitude direction matches expectations: fewer redundant parsers held warm by independent caches.

### Browser-side metrics — could not recapture

The Chrome DevTools MCP server disconnected mid-session, so no fresh LCP / CLS / heap snapshot. Manual recapture in a real browser is the recommended verification step before merging:

1. Open `/sessions` with several thousand sessions in `~/.claude/projects/`.
2. Confirm the list scrolls smoothly with constant DOM size (~30–50 rendered rows at any time, regardless of total count).
3. Confirm CLS drops from 0.53 to ≤ 0.1 — the virtualized list reserves a stable height, and rows mount before they enter the viewport (`overscan: 6`).
4. Open `/sessions/<sessionId>` for a long session — confirm `parseMarkdown` only runs for events near the viewport (`useInView` lazy-mount).
5. Background the tab on `/usage` for 30 s — confirm DevTools Network shows zero requests while hidden.

### What landed vs what's deferred

Landed in P0:
- Audio-element leak in `NotificationListener` fixed (module-level singleton).
- `optimizePackageImports` for `lucide-react` and `date-fns` in `next.config.ts` (defensive — already on by default in Next 16).
- `useMemo` on `presentCategories` and `sorted` in `UsageDashboard.ProjectBreakdownView`; `useMemo` on `activeSessions` count in `SessionsBrowser`.
- `parseMarkdown` cached via `React.memo` + `useMemo` in `SessionTimeline`. `useInView` IntersectionObserver gates content rendering until 500 px before viewport.
- Three pollers consolidated into `<PulseProvider>` + `usePulse()` + `/api/pulse`. Paused on `document.hidden`.
- `SessionsBrowser` virtualized via `@tanstack/react-virtual` — single flat-items array drives both grouped and ungrouped modes.

Deferred to P0.5 (low-priority — no measured CLS issue, can copy SessionsBrowser pattern):
- `UsageDashboard` per-session breakdown table.
- `DashboardGrid` sparkline list mode.
- `AgentsBrowser`, `SkillsBrowser`, `ManualStepsDashboard`.

---

## After P0.5 — 2026-04-30

P0.5 finished the virtualization story by **measuring before paying** instead of inheriting the P0 deferral list wholesale. Item counts from the live dataset:

| Component | Items | Verdict |
|---|---|---|
| `AgentsBrowser` | **226** | Virtualize ✅ |
| `SkillsBrowser` | **258** | Virtualize ✅ |
| `ManualStepsDashboard` | 9 | Skip — well below the ~100-row threshold where virtualization wins. |
| `DashboardGrid` (list mode) | 32 | Skip. |
| `UsageDashboard` (per-project breakdown) | 13 | Skip. |

Rule of thumb that's served the project: under ~100 simple rows, DOM cost is invisible and Ctrl-F still works; 100–500 is borderline; 500+ is where you get clear wins. SessionsBrowser at 3,211 was a 30× heap reduction; virtualizing 13 rows would have shipped a Ctrl-F regression for no measurable gain.

### What landed in P0.5

- `AgentsBrowser` and `SkillsBrowser` virtualized with `useVirtualizer` from `@tanstack/react-virtual`. Same pattern as `SessionsBrowser` from P0: inner scroll container, `measureElement` for variable row heights, `overscan: 6`.
- **State lifted from row to parent** so expand/collapse and fetched bodies survive scroll-away unmount/remount. Without this, expanding a row, scrolling past it, and scrolling back would silently re-collapse it. `expandedIds: Set<string>` and `bodiesById: Map<string, string>` now live on the browser component.
- **`bodiesById.has(id)` is the "fetched-or-not" predicate**, separate from the value — distinguishes "fetched and empty" from "never fetched" so a row with no body content doesn't keep showing the "View full body" button forever.
- **`bodiesByIdRef` mirror** prevents the fetch callback from rotating identity on every successful fetch (which would bust virtualizer measurement memoization on visible rows).

### Verification

- `npm run typecheck` clean, `npm test` 546/546 passing, `npm run build` clean.
- Manual smoke: `/agents` and `/skills` return 200 with full content rendered, virtualizer mounts only the rows currently in (or near) the viewport.
- Expand → scroll past → scroll back: row stays expanded, body content preserved.
- Filter → expand a row → narrow filter to hide it → widen filter again: row remembers its expanded state (intentional — known quirk: `expandedIds` retains keys for off-filter rows; tiny memory footprint, becomes visible again on re-include).

### What's left from the original P0.5 deferral list

Nothing. Three of the five candidates measured below the threshold; the PR description records the counts so this question doesn't reopen later.

---

## After P1 — 2026-04-30

P1 = server consolidation. New `FileCache<T>` mtime primitive in `src/lib/usage/cache.ts`, parser switched from 2-min TTL to mtime-driven cache, single-flight dedup for cold-path concurrency, `writeFileAtomic` + `withFileLock` extracted to top-level `src/lib/atomicWrite.ts` and applied across config/setup/insight/manual-step writers, scanner cache moved to `globalThis`, ETag + `Cache-Control` headers on `/api/sessions`, `/api/usage`, `/api/stats`, plain `Cache-Control` on `/api/agents`, `/api/skills`.

### API timings — cold (after `rm -rf .next` + restart, disk caches present)

| Route | Baseline cold | P1 cold | Δ |
|---|---|---|---|
| `/api/sessions` | 7.97 s | ~10.0 s | +25 % (one-time per restart) |
| `/api/usage?period=month` | 6.90 s | ~10.4 s | +51 % (one-time per restart) |
| `/api/stats` | n/a | 0.40 s | new |
| `/api/agents` | n/a | 1.66 s | new |
| `/api/skills` | n/a | 0.36 s | new |

Cold path is slightly worse on `/api/sessions` and `/api/usage` because the new in-process FileCache is empty after restart and has to stat 3,211 files plus parse changed ones. The on-disk `claudeStatsCache` is still warm, so parse work itself is bounded — most of the 10 s is fs.stat round-trips. P2 (SQLite) eliminates this cost by persisting parsed state across restarts.

### API timings — warm (in-process FileCache populated)

| Route | Baseline warm | P1 warm | Δ |
|---|---|---|---|
| `/api/sessions` | 0.21 s | **0.044 s** | **−79 %** |
| `/api/usage?period=month` | 2.27 s | **0.014 s** | **−99.4 %** |
| `/api/stats` | n/a | 0.098 s | new |
| `/api/agents` | n/a | 0.018 s | new |
| `/api/skills` | n/a | 0.020 s | new |

The 99.4 % reduction on `/api/usage` is the headline P1 win: prior to P1, every 2-min TTL miss re-parsed 1.1 GB. With mtime caching, only files that actually changed since the last sweep get re-parsed, and a stat-only sweep is ≤ 20 ms.

### API timings — 304 round-trip (with `If-None-Match`)

| Route | Time | Status |
|---|---|---|
| `/api/sessions` | 0.011 s | 304 |
| `/api/usage?period=month` | 0.016 s | 304 |
| `/api/stats` | 0.094 s | 304 |

Browsers will use these headers automatically across cross-page navigations: clicking from `/sessions` → `/usage` → `/stats` → back will short-circuit to 304s instead of full payload re-fetches as long as the underlying JSONL/scan state hasn't changed.

### Verification

- `npm run typecheck` — clean.
- `npm test` — **545/545 passing** including new `tests/fileCache.test.ts` (7 tests covering single-flight dedup, mtime/size invalidation, LRU eviction, max-mtime reporting).
- `npm run build` — clean (one pre-existing NFT warning unchanged from baseline).
- `curl -H 'If-None-Match: <etag>'` round-trip → 304 with same ETag, < 110 ms across all three routes.
- ETag inputs: max JSONL mtime + query params (`/api/usage`), in-route cache `cachedAt` + filter (`/api/sessions`), max(scan timestamp, JSONL mtime) (`/api/stats`).

### Why /api/agents and /api/skills don't get an ETag yet

Both routes depend on TWO file sources: the JSONL corpus (covered by `getJsonlMaxMtime()`) and the agent/skill catalog directories walked by `loadCatalog`. The catalog walk isn't mtime-cached yet — that lands as part of P1.5 (or naturally with P2's SQLite indexer). For now, both routes get plain `Cache-Control: private, max-age=120` matching their existing 2-min in-process TTLs, so browsers dedupe back-to-back navigations without us claiming a freshness signal we can't enforce.

### What didn't change in P1 (intentionally deferred)

- **Streaming session detail** — `/api/sessions/[sessionId]` still loads the full file. Becomes trivial once P2's SQLite holds turn metadata + byte offsets.
- **Single shared façade `src/lib/data/index.ts`** — would be churn without the SQLite backend behind it. Lands naturally with P2.
- **`loadCatalog` mtime-cache** — see above. Cheap once we touch the indexer for SQLite.

---

## After P2b-4 — 2026-05-01

`MINDER_USE_DB` and `MINDER_INDEXER` defaults flipped to on. No new perf measurement in this slice — the structural wins were already captured in P2b-2.5 (SQL aggregate path), P2b-3 (SQL session detail), P2b-3.5 (prepared-statement cache), and the reconcile-throughput fix below. P2b-4 is the rollout slice that turns those wins on for every user without an opt-in flag.

### What "default on" means in practice

For a fresh clone, `npm run dev` now:

- Boots the in-process chokidar watcher at server start (instrumentation-node.ts).
- Routes `/api/usage` and `/api/sessions/[sessionId]` through the SQLite-backed read path on every hit.
- Falls back to file-parse on driver-missing / init-failure / `meta.needs_reconcile_after_v3` set — no behavior change there; the safety net stays.

### Soak-window behavior to watch

If a previous-generation install upgrades into this slice, the FIRST boot still pays the v3 catch-up cost (~20 s now, post-reconcile-throughput fix). The DB read path falls back to file-parse during catch-up because `meta.needs_reconcile_after_v3` is set; once the reconcile completes, subsequent reads go straight to SQL. No user-visible action required.

### Methodology / verification commands

```bash
# Default-on (no flags needed):
npm run dev

# Confirm DB backend is actually serving:
curl -sI http://localhost:4100/api/usage?period=all | grep -i x-minder-backend
# expect: X-Minder-Backend: db

# Force the legacy file-parse path (escape hatch):
MINDER_USE_DB=0 npm run dev

# Suppress the watcher (e.g. for clean read-side benchmarking):
MINDER_INDEXER=0 npm run dev
```

---

## After reconcile-throughput fix — 2026-05-01

Profiled `reconcileSessionFile` against the user's real corpus (124k turns, 160 sessions) using a per-stage `MINDER_PROFILE_INGEST=1` instrumentation harness (`scripts/profile-reconcile.mjs`). The schema's own TODO at line 406 had predicted the bottleneck a year before measurement.

### Per-stage breakdown — 10-session sample across size buckets

**Before** (turns_ad trigger active):

| stage | total ms | % |
|---|---|---|
| fileRead | 41.7 | 0.0% |
| parseTurns | 46.9 | 0.0% |
| classify+price | 5.8 | 0.0% |
| detectOneShot | 2.0 | 0.0% |
| **write.delete** | **101 949** | **99.4%** |
| write.insertSession | 4.0 | 0.0% |
| write.insertChildren | 185.5 | 0.2% |
| **total** | **102 528** | **100%** |

For the 366-turn / 1 MB session: `write.delete` alone took 44 380 ms — 121 ms per cascade-deleted row. The cascade fires `turns_ad` per turn; each fire runs `DELETE FROM prompts_fts WHERE session_id=? AND turn_index=?` which is a full scan over the UNINDEXED FTS columns. 366 × 124k FTS rows × ~1 µs = ~45 seconds. Matches observation.

**After** (turns_ad dropped, writer bulk-deletes prompts_fts):

| stage | total ms | % |
|---|---|---|
| fileRead | 25.1 | 2.2% |
| parseTurns | 27.1 | 2.3% |
| classify+price | 3.9 | 0.3% |
| detectOneShot | 1.5 | 0.1% |
| **write.delete** | **964.9** | **83.5%** |
| write.insertSession | 2.4 | 0.2% |
| write.insertChildren | 55.1 | 4.8% |
| **total** | **1 155** | **100%** |

`write.delete` is still the largest stage but now ~125 ms per session (one full FTS scan to delete the session's rows in one shot), regardless of session size. **88× total speedup**, throughput `5.9 → 519 sessions/min`.

### Headline

| | Before | After | Δ |
|---|---|---|---|
| Throughput (sessions/min) | 5.9 | 519 | 88× |
| 160-session catch-up wall time | ~80–100 min | ~20 s | 240–300× |

The schema-bump catch-up that previously made every `DERIVED_VERSION` increment a multi-hour event now completes faster than a coffee break.

### Floor: the remaining 83% in `write.delete`

`write.delete` per session is dominated by `DELETE FROM prompts_fts WHERE session_id = ?` — a single full scan of the FTS5 shadow table because `session_id` is UNINDEXED. The textbook fix is to align `prompts_fts.rowid` with `turns.ROWID` (FTS5 external-content pattern) and delete by rowid in O(log N), but `turns` is `WITHOUT ROWID` so the alignment can't be authored as a schema-only change. Closing the floor would require rebuilding `turns` as a regular rowid table — out of scope for this slice. The current 88× win is sufficient to remove reconcile throughput from the master plan's risk list.

### Methodology

The migration runs automatically on the next `initDb()` (it drops the `turns_ad` trigger). To profile against a populated DB:

```
node scripts/profile-reconcile.mjs --count=10
```

The script picks 10 sessions across log10 size buckets, force-reconciles each, and prints per-stage timings via the `MINDER_PROFILE_INGEST=1` hooks. Run with the indexer worker disabled (set `MINDER_INDEXER=0`) so timings are clean of writer contention.

---

## After P2b-3.5 — 2026-05-01

Prepared-statement cache landed (`prepCached(db, sql)` helper in `src/lib/db/connection.ts`, applied to all read-side SQL in `usageFromDb.ts` + `sessionDetailFromDb.ts`). Measured `/api/usage?period=all` against the user's real DB with the v3 readiness flag temporarily cleared and the indexer worker disabled (so DB-side measurements are clean of HTTP-vs-write contention).

### `/api/usage?period=all` timing — same corpus as P2b-2.5

| Backend | Cold (route compile + first hit) | Warm (8 runs, range / mean) | Verdict |
|---|---|---|---|
| File-parse (master baseline) | 16.6 s | 30–72 ms (~45 ms) | reference |
| SQL (P2b-2.5, no cache) | 4.2 s | 27–34 ms (~31 ms) | inside target |
| **SQL (P2b-3.5, with cache)** | **4.7 s** | **18–24 ms (~21 ms)** | **~30% faster than P2b-2.5** |

Both runs are dev mode (`MINDER_USE_DB=1 MINDER_INDEXER=0 npm run dev`, Turbopack route compile included in cold). Backend confirmed via `X-Minder-Backend: db` header on every response.

### What the cache actually buys

Theoretical estimate was 1–3 ms (17 prepares × ~50–200 µs each). Measured delta is closer to 10 ms — larger than the bare prepare-cost arithmetic. Two factors that probably explain the gap:

1. **Statement reuse skips per-call SQL parsing AND query-plan re-validation.** better-sqlite3's `prepare()` does both — the second cost (re-validating against the schema) is documented but not benchmarked explicitly in their docs.
2. **Hot-path JS less garbage.** Each `db.prepare()` allocated a fresh `Statement` wrapper object; reusing one drops 17 allocations + their finalizers per request. On a 20 ms request that adds up.

The delta is real but the absolute number (~10 ms saved on a ~30 ms request) is below the noise floor of cross-machine comparison. Frame this as "structural — the cache shape is correct for the `MINDER_USE_DB` default flip that landed in P2b-4" rather than "a major perf win."

### Methodology

```bash
# 1. Kill any running dev server, clear v3 gate, restart bare-bones
node -e "
  import('better-sqlite3').then(({default: D}) => {
    const db = new D(require('os').homedir() + '/.minder/index.db');
    db.prepare(\"DELETE FROM meta WHERE key='needs_reconcile_after_v3'\").run();
    db.close();
  });
"
MINDER_USE_DB=1 MINDER_INDEXER=0 npm run dev   # disable worker for clean reads

# 2. Warmup — compiles route, first SQL prepare for every statement
curl -sS -o /dev/null -w "cold: %{time_total}s\n" \
  "http://localhost:4100/api/usage?period=all"

# 3. 8 warm runs — the cache is now populated for all 17 statements
for i in 1 2 3 4 5 6 7 8; do
  curl -sS -o /dev/null -w "warm-$i: %{time_total}s\n" \
    "http://localhost:4100/api/usage?period=all"
done

# 4. Restore v3 gate, restart with worker
node -e "
  import('better-sqlite3').then(({default: D}) => {
    const db = new D(require('os').homedir() + '/.minder/index.db');
    db.prepare(\"INSERT OR REPLACE INTO meta(key,value) VALUES('needs_reconcile_after_v3','1')\").run();
    db.close();
  });
"
```

---

## After P2b-2.5 — 2026-05-01

SQL-aggregate read path landed (`turns.cost_usd`, `category_costs` rollup, direct SUM/GROUP BY in `loadUsageReportFromSql`). Measured `/api/usage?period=all` against the user's real DB (222 MB SQLite, 160 sessions, 124 077 turns; partially-reconciled at 23.8% v3 to capture timing without waiting for the full re-derive — query workload is data-volume-driven, not value-driven).

### `/api/usage?period=all` timing

| Backend | Cold (route compile + first hit) | Warm (5 cache-busted runs, mean) | Verdict |
|---|---|---|---|
| File-parse (master baseline) | 16.6 s | 30–72 ms (~45 ms) | reference |
| **SQL (P2b-2.5)** | **4.2 s** | **27–34 ms (~31 ms)** | **inside 50–200 ms target** |

Both are dev mode (`pnpm run dev`, Turbopack route compile included in cold). Backend confirmed via `X-Minder-Backend` header on each response.

### What this means for the P2b backlog

- **P2b-2.6 (switch byModel/byProject/byDaily/totals to read `daily_costs` rollup) is deferred indefinitely.** The current path scans `turns ⨝ sessions` directly, but with `mmap_size=256MB` keeping the 222MB DB resident and `turns_by_role_ts(role, ts)` covering the WHERE clause, hash aggregates run in 27–34 ms. Going through `daily_costs` would shave a few ms off but is not needed to hit the master plan's perf target. Revisit only if the corpus grows ~10× or warm timing drifts above 100 ms.
- **Cold path is 4× faster** than file-parse (4.2 s vs 16.6 s) — the structural win the master plan promised on the cold-cache scenario.
- **Warm path is competitive with file-parse warm** because file-parse warm benefits from the `parseAllSessions` in-memory cache (`__usageFileCache`, 2-min TTL). Counter-intuitively, SQLite hash-aggregates in C beat V8's `for...of` JS reduces over the same data — SQL warm (~31 ms) is actually slightly faster than file-parse warm (~45 ms).

### v3 reconcile pace — flag for future tuning

The DERIVED_VERSION bump triggered a full re-derive of all 160 sessions. Observed pace: ~38 sessions in 32 minutes (~1.2 sessions/min, decelerating). At this rate the corpus catches up in ~80–100 minutes of wall-clock time — an order of magnitude longer than the master plan's "30–60 s first-boot indexing" estimate. Likely root causes:

- Per-session: full JSONL re-parse (50 MB cap) + DELETE-with-FK-cascade + INSERT all turns/tool_uses/file_edits. Each session writes ~1000–10 000 row INSERTs in one transaction.
- Sequential per-file because all writes go through the single writer connection.
- Possible: contention with HTTP-side reads under dev-mode load; cleaner pace expected when worker is the only client.

This is one-time on schema bumps; tail-append remains cheap. Worth a follow-up perf pass if we ever ship a third schema bump (`P2c`+) — batching per-tuple rollup refreshes and considering parallel parse + serialized write would meaningfully reduce the bump cost.

### Methodology

```bash
# 1. Start dev server with DB backend, no worker (read-only timing)
MINDER_USE_DB=1 pnpm run dev

# 2. Warmup (compiles route, first SQL hit)
curl -sS -o /dev/null -w "warmup: %{time_total}s\n" \
  "http://localhost:4100/api/usage?period=all"

# 3. 5 cache-busted runs
for i in 1 2 3 4 5; do
  curl -sS -o /dev/null -w "run $i: %{time_total}s\n" \
    "http://localhost:4100/api/usage?period=all&_=$i"
done

# Confirm backend
curl -sS -D - -o /dev/null "http://localhost:4100/api/usage?period=all" | \
  grep -i x-minder-backend
```

---

## How to recapture after each phase

After landing each phase (P0/P1/P2/P3), append a new section to this file titled `## After P<n> — <date>` with the same tables filled in fresh, then add a final `### Delta vs baseline` subsection with percentage changes. Do not edit the baseline tables above — they are frozen as the reference point.

### Recapture commands

```bash
# 1. Build + bundle sizes
npm run build
node docs/perf/bundle-summary.mjs .

# 2. API timings — start dev server fresh, then
bash docs/perf/api-bench.sh

# 3. Server memory — while server idle after sweep
# (Windows PowerShell)
# Get-Process node | Sort-Object -Descending WorkingSet | Select-Object Id, @{N='RSS_MB';E={[math]::Round($_.WorkingSet/1MB,1)}}

# 4. Performance traces + memory snapshot — Chrome DevTools MCP
#   navigate_page → performance_start_trace (reload:true) → traces saved per page
#   take_memory_snapshot on /sessions
#   list_network_requests after a 30 s idle on /usage
```

---

## After P0 residual — 2026-05-13

Client-only cleanup. No data-layer changes. Finishes the originally-deferred P0 items that were either missed or consciously skipped in the first pass (P0 → P0.5, 2026-04-30).

**Branch:** `perf` (squash-merged to `main` after typecheck + full test suite pass)

### What changed

| Component | Change |
|---|---|
| `MarkdownContent.tsx` | Wrapped in `React.memo` + hoisted parse loop to `buildElements` helper called via `useMemo([content])`. Previously ran on every parent re-render regardless of whether `content` changed. |
| `ManualStepsNavBadge.tsx` | Deleted `setInterval(fetch, 30_000)` against `/api/manual-steps?pending=true`. Replaced with `usePulse().snapshot.pendingSteps` — already in the 5s pulse stream. |
| `ManualStepsDashboard.tsx` | Outer `sorted.map` virtualized via `useVirtualizer` with `measureElement` for dynamic row heights (collapsed vs. expanded sections). Scroll container `calc(100vh - 260px)`. Expand-all / Collapse-all toggle preserved. |
| `SparklineList.tsx` | `<table>/<tbody>` converted to CSS `display: grid` with shared `COLS` constant for header/body column alignment. Rows virtualized via `useVirtualizer`, `estimateSize: 50`. Per-row `pendingTodos`, `pendingSteps`, `lastSession` IIFE and `Date.now()` computations hoisted to a memoized `enrichedSorted` array (deps: `[sorted, activityData, pinnedSlugs]`). |

**Why ManualStepsDashboard and SparklineList were revisited:** P0.5 measured these at 9 and 32 rows respectively and applied the "below 100 rows → skip" rule. Since then, the project count and manual-step entry count have grown, and the per-row cost on SparklineList (one `ActivitySparkline` + one `DevServerControl` per row) is higher than a simple text row. Re-evaluation at ~61 projects / growing manual-steps list put both back above the cost threshold.

### Bundle sizes (`node docs/perf/bundle-summary.mjs .`)

Captured 2026-05-13 on branch `perf` after all four changes. The codebase grew substantially since the April 30 baseline (Claude status alerts, MCP server, Agent Observatory waves 4–5, etc.) so direct route-level comparisons to April 30 carry confounding features. The P0 residual changes themselves add no new dependencies.

| Route | Apr-30 baseline (KB) | After P0 (KB) | Post-P0-residual (KB) | Δ vs Apr-30 |
|---|---|---|---|---|
| `/` (SparklineList here) | 719.5 | 720.1 | 629.7 | −89.8 |
| `/manual-steps` | 574.0 | n/a | 642.9 | +68.9 (new features) |
| `/insights` (MarkdownContent heavy) | 570.4 | n/a | 622.3 | +51.9 (new features) |
| `/sessions` | 581.1 | 598.0 | 660.4 | +79.3 (new features) |
| Shared baseline | 560.9 | 561.5 | 613.5 | +52.6 (new features) |

**Key reading:** The `/` drop of 89.8 KB vs Apr-30 reflects both the P0 work (react-virtual added) and the P0 residual SparklineList changes. The increases on other routes are from feature additions after April 30, not from this residual pass. The P0 residual changes contribute no new bundle weight.

### Idle network improvement

`ManualStepsNavBadge` eliminated its independent 30s poller. The badge now reads `snapshot.pendingSteps` from `PulseProvider` (5s, shared, paused on `document.hidden`).

| Source | Before (requests/30 s) | After (requests/30 s) |
|---|---|---|
| `ManualStepsNavBadge` → `/api/manual-steps?pending=true` | 1 | **0** |

Combined with P0's pulse consolidation, this is now the last known independent idle poller on the standard navigation paths (excluding dev-mode singletons like `DevServerControl` in compact mode on each SparklineList row).

### What still needs manual measurement

The following were not captured in this slice and should be recaptured in a browser session:

1. **`/manual-steps` DOM node count before/after** — confirm only viewport rows mount when `ManualStepsDashboard` is virtualized. Ballpark target: ~15–25 `<div>` rows in DOM regardless of total project count.
2. **`/insights` React Profiler trace** — confirm `MarkdownContent` shows gray (skipped) bars in Profiler when the parent re-renders without changing `content`. This validates the `memo` wrap is exercised.
3. **SparklineList visual regression** — side-by-side `/` with table (pre-change) vs. grid (post-change) on narrow viewport. Check horizontal overflow, column alignment, and `position: sticky` header when scrolling 60+ rows.
4. **CLS on `/manual-steps`** — prior baseline not captured; recapture with Lighthouse to get a starting number for P3 comparison.
