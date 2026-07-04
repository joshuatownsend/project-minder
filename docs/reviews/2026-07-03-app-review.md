# Project Minder — App Review & Findings

**Date:** 2026-07-03
**Commit reviewed:** `8b66df7`
**Method:** Five parallel read-only audit passes (data-pipeline correctness, usage-analytics accuracy, security & exec surfaces, architecture/tech-debt, config/docs/DX), then manual vetting of load-bearing findings against source.
**Status:** Findings for review only. No code was modified. Next step is to select what becomes a repair/refactor plan.

---

## TL;DR

Project Minder's core plumbing is genuinely well-engineered (single-flight guards, generation counters, mtime-keyed caching, atomic writes with file locks). The problems cluster in three areas:

1. **Accuracy gaps that undercut the product promise** — subagent/Task token cost is silently dropped from *all* usage totals, and daily charts bucket by UTC while "today" filters use local time. The dashboard's headline numbers are wrong for anyone who uses subagents or lives in a negative-UTC offset.
2. **A localhost CSRF surface** — every state-changing API route trusts any origin. A malicious web page you visit can drive the dashboard's API (start/stop dev servers, mutate boards, widen scan roots, read the entire local index via `/api/sql`).
3. **Breadth over depth debt** — a shipped-but-dormant RSC/SSE migration behind default-off flags, ~40 routes (4 are stubs), a dozen legacy pollers the migration was supposed to replace, and unbounded per-route caches.

Severity legend: 🔴 High · 🟠 Medium · 🟡 Low. Confidence noted per item.

---

## 1. Correctness / accuracy — these make the dashboard *lie*

### 🔴 A1. Subagent/sidechain token cost excluded from all usage totals — *confirmed*
`src/lib/usage/parser.ts:174` (`if (entry.isSidechain && !options.includeSidechains) continue;`) and `src/lib/db/ingest.ts:576`. `aggregator.ts` calls `parseAllSessions()` with no options, so `includeSidechains` is falsy and **every Task/subagent turn's input/output/cache tokens and cost are dropped** from `totalCost`, `totalTokens`, `byModel`, `byProject`, and `daily`. Both the JSONL and DB backends do this identically, so it's not a backend-divergence bug — it's a systematic undercount. For subagent-heavy workflows (like this very audit), real Claude spend is materially understated.
**Fix:** Include sidechain turns in the totals (they aren't double-counted elsewhere), or surface a separate "subagent cost" line that folds into the headline total.

### 🟠 A2. Daily chart buckets by UTC; "today"/streak/heatmap use local time — *confirmed via code paths*
`src/lib/usage/aggregator.ts:255` (`timestamp.slice(0,10)`) and `src/lib/data/usageFromDb.ts:339` (`substr(t.ts,1,10)`) bucket the daily cost chart by UTC date, while `periods.ts` ("today" = local midnight) and `activityBuckets.ts` (local hours/days) use local time. For negative-UTC users, late-evening turns land on the next day's bar, and the "today" total won't match the daily bars or the contribution calendar.
**Fix:** Pick one basis — local — for daily buckets, matching the period filter and heatmap.

### 🟠 A3. Intent categories can't attribute cost — *confirmed*
`src/lib/usage/classifier.ts:63-77`. Debugging/Refactoring/Planning/Brainstorming are decided from `userMessageText`, which the parser only populates on *user* turns (0 tokens). Token-bearing assistant turns fall through to Coding/Feature Dev/General, so the "usage by category" cost breakdown shows ≈0 for those intent categories — a systematic skew in a headline view.
**Fix:** Propagate the triggering user prompt's intent onto the following assistant turns before costing.

### 🟠 A4. 1M-context / >200k tiered pricing ignored — *confirmed*
`src/lib/usage/costCalculator.ts:256` (`applyPricing`) does a flat per-token multiply; LiteLLM's `input_cost_per_token_above_200k_tokens` surcharge (Claude bills ~2× above 200k) is never parsed or applied. Large-context turns are systematically underpriced. (Note: PR #245 mapped the *context window* to 1M but did not add tiered *pricing*.)
**Fix:** Read the `*_above_200k_tokens` fields and split token cost at the 200k boundary.

### 🟠 A5. Per-category one-shot rate crosses session boundaries — *confirmed*
`src/lib/usage/aggregator.ts:313`. The headline one-shot stat is correctly session-grouped, but `byCategory[].oneShotRate` runs the edit→verify→result scan over turns grouped only by category, mixing unrelated sessions in scan order. An edit in one session can pair with a verification from another.
**Fix:** Segment `catTurns` by `sessionId` before calling `detectOneShot`.

### 🟡 A6. No usage dedup by `message.id`/`requestId` — *plausible, latent*
`src/lib/usage/parser.ts:184-188`. Usage is summed from every assistant entry with no dedup key. If Claude Code ever emits multiple lines sharing a `message.id` (retry, resumed session re-log, streamed update), tokens double-count with no guard.
**Fix:** Track seen `message.id` per session; skip repeats when accumulating.

### 🟡 A7. Miscellaneous costing skews — *confirmed, low impact*
- Cache-hit-rate denominator omits `cacheCreate` (`aggregator.ts:343`), overstating hit rate on cache-write-heavy sessions.
- Over-broad `DEBUGGING_RE` (`classifier.ts:12`) tags "fix the copy" as Debugging.
- Novel Claude model IDs fall back to Sonnet-4 pricing when offline (`costCalculator.ts:189`), silently wrong for an Opus-tier future model.

### Data-pipeline correctness (scanner side)

- 🟠 **B1. Session lookup is case-sensitive on Windows** — *confirmed.* `src/lib/scanner/claudeSessions.ts:47,95,109`. `normalizePath` swaps `\`→`/` but doesn't lowercase, so a `C:` vs `c:` / `Foo` vs `foo` mismatch between `history.jsonl`'s recorded cwd and the scanned dir makes the lookup miss — sessionCount/lastPrompt/lastSessionDate silently blank, which also demotes the project in the activity sort. The insights scanner already `.toLowerCase()`s the same key; this one doesn't. **Fix:** lowercase both sides of the history-map key and the worktree `startsWith`.
- 🟠 **B2. Deleted-then-recreated MANUAL_STEPS.md is never re-watched** — *confirmed.* `manualStepsWatcher.ts:101,170`. On watcher error/delete the handler nulls `entry.watcher` but leaves the slug in `this.watched`, and `scanForFiles` skips slugs already present — so a removed-and-recreated file is orphaned until server restart. **Fix:** `this.watched.delete(slug)` in the error/close handler.
- 🟠 **B3. Watcher can go deaf after the app's own atomic write** — *confirmed (platform-dependent).* `manualStepsWatcher.ts:162` + `atomicWrite.ts:93`. `fs.watch` on a single file breaks when writers replace it via tmp-file `rename` (inotify bound to the unlinked inode). After the first in-app toggle, subsequent *external* edits are missed on Linux/macOS; Windows generally survives. **Fix:** watch the parent dir filtered to the filename, or re-arm after each change.
- 🟠 **B4. Detached HEAD drops the entire GitInfo block** — *confirmed.* `scanner/git.ts:111`. `git branch --show-current` returns "" for detached HEAD, and the code then `return undefined`, discarding commit date/message and remote for a valid repo. **Fix:** fall back to `git rev-parse --abbrev-ref HEAD` and keep populating commit/remote.
- 🟡 **B5. Git subprocess failures look identical to "clean"** — `scanner/git.ts:7,176`. `runGit` swallows every error to `""`, so a transient failure (index.lock, timeout, git missing) renders a dirty repo as clean with no error surfaced. **Fix:** distinguish exec failure from empty stdout.
- 🟡 **B6. devPort parser misses `--port=`/`-pNNNN` forms** — `scanner/packageJson.ts:63`, `processManager.ts:188`. Regex requires whitespace, so `next dev --port=4100` falls through to the framework default → wrong port shown, bogus/missed port-conflict. **Fix:** `(?:--port[= ]|-p ?)(\d+)`.
- 🟡 **B7. `.env.example` placeholders leak into project metadata** — `scanner/envFile.ts:89`. If `.env` lacks `DATABASE_URL`, the example's placeholder connection string is parsed as the real DB, surfacing fake infra in the Operations panel. **Fix:** drop `.env.example` from the DB-URL/service source list.
- 🟡 **B8. Parser drop-zones** — `manualStepsMd.ts:5` (steps under non-date headers vanish), `boardMd.ts:165` (single-tab-indented detail lines dropped). **Fix:** loosen both patterns.
- 🟡 **B9. Case-insensitive file-lock key** — `atomicWrite.ts:42`. `withFileLock` keys on `path.resolve` (separators normalized, case not), so differently-cased paths to the same file get different locks → lost-update risk. Latent today. **Fix:** lowercase the lock key on win32.

---

## 2. Security — localhost API is drivable cross-site

> All of these are "by design there's no auth," which is fine for a local tool. The issue is that *no auth* combined with *no origin check* means any website your browser visits can reach `http://localhost:4100/api/*`.

### 🔴 S1. No Origin/Host validation on any state-changing route — *confirmed*
No `src/middleware.ts` exists; no API route reads Origin/Host. Confirmed on `api/dev-server/[slug]`, and by grep across `api/`. Only `/api/mcp` has DNS-rebinding protection. A malicious page can send a CORS "simple" `POST` (`Content-Type: text/plain`, no preflight) and drive: dev-server start/stop, board mutations, config changes (including widening `devRoots`), scans, manual-step toggles.
**Fix:** one shared Origin/Host allowlist check (`localhost:4100` / `127.0.0.1:4100`) applied to all non-GET routes via middleware — this single fix neutralizes S1–S5.

### 🔴 S2. Unvalidated `port` flows into a process spawn — *confirmed data flow; RCE uncertain*
`api/dev-server/[slug]/route.ts:44` types `port?: number` but `request.json()` enforces nothing at runtime. It reaches `processManager.start` → `String(portOverride)` written into `args` (`processManager.ts:56`) → `spawn("cmd.exe", ["/c", command, ...args])` (`platform.ts:64`). A string like `"4100 & calc"` becomes a spawn arg with no integer validation.
*Vetting note:* Node quotes args containing `&` when spawning cmd.exe, so trivial `&`-injection likely does **not** execute — I'd rate actual RCE **plausible-but-unconfirmed**, not certain. Regardless, the input is unvalidated and the fix is trivial and clearly warranted; combined with S1 it's the scariest path.
**Fix:** validate `port` is an integer 1–65535 in the route before it reaches `processManager`.

### 🔴 S3. `/api/sql` exposes the entire local index; no Host check — *confirmed*
`api/sql/route.ts`. The SELECT-only enforcement is genuinely solid (regex lead-check + `stmt.readonly`/`stmt.reader` + 10k row clamp) — that part is *not* the problem. The problem is it runs arbitrary read `SELECT`s over `~/.minder/index.db` (session prompts, token usage, all project data) with no Host validation, so a DNS-rebinding site can read every response and exfiltrate all local Claude Code data.
**Fix:** enforce the same Host allowlist the MCP transport uses (covered by S1's middleware).

### 🟠 S4. `processManager.start` check-then-act race → orphaned processes — *confirmed*
`processManager.ts:41-130`. `isRunning` is checked at entry but `this.processes.set` happens only after `detectDevCommand` + a 2000ms timer. Two overlapping starts for one slug both spawn; the first child is overwritten in the map and never tracked or killed.
**Fix:** insert a per-slug in-flight placeholder synchronously before the first await.

### 🟠 S5. `devRoots` is a CSRF-mutable allowlist gating path validation — *confirmed*
`api/config/route.ts:38`. `validateProjectPath` and reveal's `isPathAllowed` trust `getDevRoots(config)`. `PATCH /api/config` can widen `devRoots` to `C:\`; combined with S1, a site can broaden the allowlist then aim S2's spawn at attacker-chosen directories. **Fix:** treat `devRoots` writes as sensitive (covered by S1).

### 🟡 S6. Minor CSRF-reachable surfaces — `api/reveal` (spawns explorer/open — annoyance/DoS), `api/notifications/push/subscribe` (redirect notifications to attacker endpoint), `api/events` SSE (coarse "data changed" only). All resolved by S1's Origin check.

### ✅ Confirmed safe (no action)
- **Secrets are never surfaced** — `scanEnvFiles` emits env *key names* / service labels and a password-stripped DB host only; `secrets/*` GET returns `{configured, mtime}` booleans. No credential value is exposed.
- **gh/git shelling is safe** — `githubRemote.ts` validates `owner/repo` against `^[A-Za-z0-9._-]+$`; callers use `execFile` arrays.
- **Board/manual-steps writers are path-safe** — slug → validated project path → `canonicalProjectDir` + `withFileLock` + atomic write to a fixed filename; MCP `SlugSchema` is strict.
- **MCP endpoint** correctly pins allowed hosts/origins to `:4100` with DNS-rebinding protection.

---

## 3. Architecture / tech debt

### 🔴 C1. RSC-prefetch + SSE migration shipped but dormant behind default-off flags — *confirmed*
`src/lib/featureFlags.ts` (`rscHydration`, `serverActions`, `liveEvents`), `src/lib/server/prefetch.ts`. The entire PR #237–#243 effort (prefetch.ts, 10 prefetchers, HydrationBoundary on 11 pages, SSE bus) is gated `false` by default. **In the default config the app runs the legacy fetch-on-mount + polling paths**, so the new architecture is untested in normal use *and* pure maintenance weight.
**Decision needed:** per-flag, flip to default-on after validation or delete the dormant path. This is the single biggest lever on the codebase's coherence.

### 🟠 C2. ~12 bespoke pollers never migrated — *confirmed*
`useEfficiencyGrades.ts:45`, `useGitDirtyStatus.ts:85`, `useGithubActivity.ts:81`, `StatusDashboard.tsx:62` (3s), `DevServerControl.tsx:82` (2s), `SettingsPage.tsx:199`, `BackgroundActivityBrowser.tsx:100`. Hand-rolled `setInterval`+`fetch` loops duplicate what TanStack Query (already a dep, used by 10 other hooks) provides, several running regardless of tab visibility. Plus **two global 60s pollers hit claude-status redundantly** (`ClaudeStatusBanner.tsx:82` + `ClaudeStatusListener.tsx:81`). **Fix:** port to `useQuery`/SSE; consolidate the status pollers into one provider.

### 🟠 C3. Per-route globalThis Map caches grow unbounded — *confirmed*
~15 route modules (`api/sessions/[sessionId]/{agent-network,concurrency-timeline,model-delegation,…}`, `api/projects/[slug]/{efficiency,error-propagation,file-coupling,hot-files,patterns}`) do `globalThis.__xCache ??= new Map()` with a read-time TTL check but **no size cap, no deletion, no HMR dispose**. Distinct session/project keys accumulate for the server's lifetime and duplicate across dev reloads. Note `skillUpdateCache.ts:243` also lacks the `dispose()`/generation guard its sibling caches have. **Fix:** use a bounded LRU + HMR dispose.

### 🟠 C4. Dual SQLite/JSONL backend duplicated per-function — *confirmed*
`src/lib/data/index.ts` (1045 lines, 16 `MINDER_USE_DB` branches) + `usageFromDb.ts` (753). Every data function forks DB vs file-parse; cross-backend parity is maintained by hand via comments. Any change to one path silently diverges the other. **Fix:** unify behind one interface with shared post-processing applied to both backends' raw rows.

### 🟠 C5. Catalog + efficiency grading are O(projects × sessions) — *confirmed*
`indexer/catalog.ts:78` (`Promise.all` over all projects, no batch limit → fd pressure at ~61 projects) and `efficiencyGradeCache.ts:53` (re-scans the full session map per project). **Fix:** reuse the scanner's `BATCH_SIZE` batching; index sessions by slug once.

### 🟡 C6. Route sprawl & dead code — 4 routes are pure `<ComingSoon>` stubs (`analytics`, `health`, `schedule`, `timeline`) yet appear in nav; `ComingSoonPage.tsx` is a fuller duplicate imported by nobody. `wired: false` feature flags render as user-visible Settings toggles that do nothing. **Fix:** hide stubs/unwired flags from UI; delete the dead component.

### 🟡 C7. Oversized modules concentrate risk — `db/ingest.ts` (2841), `types.ts` (1563), `UsageDashboard.tsx` (1279), `data/index.ts` (1045), `claudeConversations.ts` (1021), `SessionDetailView.tsx` (1015). The backend-drift + reconcile logic lives in the least-tested units. **Fix:** split `ingest.ts` (reconcile/merge/write) and slice `types.ts`.

### 🟡 C8. RSC migration left the app half-and-half — ~11 pages became RSC shells with HydrationBoundary while the rest stay all-client (the documented v1 convention), with no stated rule for which applies. Home (`page.tsx`, 817 lines) and `projects` are still client. **Fix:** document the boundary or finish the high-traffic pages.

---

## 4. Config / docs / DX

- 🟠 **D1. pnpm overrides split-brain** — *confirmed.* `package.json` still carries `pnpm.overrides` (hono/vite/@babel/core) and an `onlyBuiltDependencies` list, while `pnpm-workspace.yaml:16` carries *different* overrides (postcss/zod) and its own comment says pnpm 11+ no longer reads package.json. A pnpm 11 upgrade silently drops the hono/vite/babel security pins. **Fix:** consolidate all overrides + built-deps into `pnpm-workspace.yaml`.
- 🟠 **D2. ~34 DB test files skip silently; CI still green** — *confirmed.* Suites gated by `describe.skipIf(!driverAvailable)`; if better-sqlite3's native build fails in CI, the whole DB/ingest/OTEL layer skips and CI passes. `it.skipIf(platform!=='win32')` tests never run on ubuntu-only CI at all — for a Windows-targeted app. **Fix:** assert the driver loaded (fail if skipped); add a windows-latest job.
- 🟠 **D3. Thin route/component test coverage** — 5 API-route tests vs ~40 routes; zero `*.test.tsx`. **Fix:** extend the plan-005 API harness; add a component smoke suite.
- 🟠 **D4. help-mapping.ts missing 7 live routes** — `/analytics`, `/background`, `/commands`, `/health`, `/projects`, `/swarms`, `/timeline` have neither a route→slug entry nor a help doc, so in-app "?" resolves nothing. **Fix:** add mappings + docs, or hide "?" on undocumented pages.
- 🟡 **D5. Stale docs** — CLAUDE.md's architecture/route inventory omits ~13 shipped surfaces (adapters, analytics, background, commands, kanban, memory, plans, plugins, sql, swarms, tasks, templates, timeline). CHANGELOG skips PRs #239–#243 (jumps #238→#244). **Fix:** refresh both.
- 🟡 **D6. CI matrix gap** — one Node (20.19.0) and one OS (ubuntu), though engines allow Node 22 and the app targets Windows. **Fix:** add Node 20/22 × ubuntu/windows matrix.
- 🟡 **D7. Pre-commit hook not version-controlled, skips lint/build** — new clones have no gating until they run `pnpm setup-hooks`; hook omits lint/build that CI enforces. **Fix:** document in README onboarding; add lint to the hook.
- 🟡 **D8. Working-tree drift** — `tsconfig.json` has an uncommitted `"incremental": true`; a stray Windows-reserved `nul` file sits in the working dir (untracked but can break tooling/checkout). **Fix:** commit or revert tsconfig; delete `nul`.

**Verified non-issues:** no unused dependencies among the flagged suspects (web-push, sanitize-html, d3-sankey, smol-toml, chokidar, cron-parser, claude-code-lint are all used — claude-code-lint via `require.resolve` in next.config.ts). Root "junk" (`agentlytics-repo/`, `dist/`, screenshots, `t2.1-*.png`) is gitignored, not committed. `plans/README.md` status is accurate. CI does run the full lint+typecheck+test+build gate.

---

## Missing insight (gaps vs "full insight into Claude Code usage")

Data that exists in `~/.claude` but is never surfaced:
- **Subagent/Task cost** as part of portfolio total (dropped today — see A1).
- **1h ephemeral cache-write pricing** (2× vs 5m) — `cache_creation_input_tokens` isn't split by TTL.
- **Extended-thinking token share** — `hasThinking` is captured but thinking tokens aren't broken out as a cost line.
- **Server-side tool costs** (web search / web fetch per-call charges) — not modeled.
- **Recorded per-message `costUSD`** (when Claude Code writes it) is ignored — no reconciliation/cross-check against recomputed cost.
- **Long-context (>200k) session flagging** — no view of how much spend happens in the expensive tier.
- **Per-tool token/cost attribution** — tools are counted but not costed (cost of Bash vs Read vs MCP).

---

## Suggested priority order for a plan

1. **S1 (Origin/Host middleware)** + **S2 (validate port)** — one small middleware + one guard closes the whole cross-site surface. Highest safety-per-effort. *(S · low risk)*
2. **A1 (subagent cost)** + **A2 (UTC/local day)** — the accuracy fixes that make headline numbers trustworthy. *(S–M · needs test coverage)*
3. **B1–B4 scanner correctness** — small, high-confidence fixes that stop the dashboard silently blanking real data. *(S each)*
4. **C1 decision (RSC/SSE flags)** — resolve dormant migration before it rots; unblocks C2 (kill the pollers). *(M–L · architectural call needed first)*
5. **D1 (pnpm pins)** + **D2 (CI driver assertion + windows job)** — cheap supply-chain/CI hardening. *(S)*
6. **C3/C4/C5 performance & drift** — bounded caches, unified backend, batched catalog. *(M–L)*

Everything above is a candidate, not a commitment — pick the set you want turned into an implementation plan.
