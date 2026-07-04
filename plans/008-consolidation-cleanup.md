# Plan 008 — Consolidation & Cleanup (go-big)

**Created:** 2026-07-03 · against commit `8b66df7` (v1.1.0)
**Source:** `docs/reviews/2026-07-03-app-review.md` (five-track audit; findings vetted against source)
**Goal:** Address **all** review findings. Consolidate churn/bolt-on debt, restore accuracy of the dashboard's headline numbers, close the cross-site surface, and **enable the dormant RSC/SSE architecture** (flip `rscHydration`/`serverActions`/`liveEvents` on by default once validated).
**Mode:** Autonomous overnight run. Work split into stacked feature branches → one PR each. Sequential, dependency-ordered. Each PR self-verifies (`pnpm typecheck` + `pnpm test`) and is committed only when green.

## Execution rules

- **Never push to main.** Each PR is its own branch, stacked on the previous (base = prior branch) so cumulative typecheck/tests stay green. Merge order = PR order.
- **Verification gate per PR:** `pnpm typecheck` then `pnpm test` must pass; report exact counts in the PR body. No commit on red.
- **Path-scoped commits only** (never `git add -A`): the working tree carries unrelated `INSIGHTS.md` (append-only, leave it) and a throwaway `tsconfig.json` experiment (reverted in PR E).
- **Bounded retries:** if a subagent's change fails the gate, one fix attempt (self or redispatch); if still red and the PR is non-foundational, mark BLOCKED and continue with independent PRs. Foundational blocks (A) stop the run.
- **Docs discipline:** any user-facing change updates `docs/help/**` + `public/help/**` + `CHANGELOG.md [Unreleased]` in the same PR (repo policy).

## Model assignment (complexity/cost tiering)

| Tier | When | Used for |
|------|------|----------|
| **Haiku** | Mechanical, fully-specified, low branching | Docs refresh, dead-code deletion, mechanical config edits |
| **Sonnet** | Standard implementation with clear spec, moderate reasoning | Security guards, scanner fixes, cache bounding, tests, CI/infra |
| **Opus** | High branching, correctness-critical, cross-cutting refactor | Usage cost accounting, RSC/SSE enablement, dual-backend unification, god-module splits |

## PR sequence

| # | Branch | Scope | Findings | Model | Risk |
|---|--------|-------|----------|-------|------|
| A | `cleanup/a-security` | Origin/Host middleware, port validation, spawn race, devRoots sensitivity | S1,S2,S4,S5,S6 | Sonnet | Low |
| B | `cleanup/b-usage-accuracy` | Subagent cost, UTC/local day, category attribution, tiered pricing, one-shot-by-session, dedup, cache-hit denom + tests | A1–A7 | **Opus** | Med |
| C | `cleanup/c-scanner-correctness` | Case-insensitive keys, watcher re-arm, detached HEAD, git error state, port regex, .env.example, parser drop-zones, lock key | B1–B9 | Sonnet | Low-Med |
| D | `cleanup/d-docs-deadcode` | CLAUDE.md route inventory, CHANGELOG backfill, help-mapping, delete ComingSoonPage, hide stub routes + unwired flags | C6,D4,D5 | **Haiku** | Low |
| E | `cleanup/e-infra` | pnpm overrides consolidation, CI driver-loaded assertion + Node/OS matrix, hooks doc+lint, revert tsconfig, delete `nul` | D1,D2,D6,D7,D8 | Sonnet | Low |
| F | `cleanup/f-caches-perf` | Bounded LRU for per-route caches + HMR dispose, skillUpdateCache dispose, batched catalog walk, session-index-by-slug | C3,C5 | Sonnet | Med |
| G | `cleanup/g-test-harness` | Extend API characterization harness across high-traffic routes; component smoke suite | D3 | Sonnet | Low |
| H | `cleanup/h-rsc-sse` | Flip `rscHydration`/`serverActions`/`liveEvents` default-on after validation; port ~12 bespoke pollers → useQuery/SSE; consolidate dual claude-status pollers | C1,C2 | **Opus** | High |
| I | `cleanup/i-backend-unify` | Unify SQLite/JSONL behind one interface w/ shared post-processing; split `ingest.ts` + slice `types.ts` | C4,C7 | **Opus** | High |

**Rationale for order:** land the high-value, low-risk fixes (A–G) first so a failure in the risky big-refactors (H, I) never blocks the safe wins. H before I because I touches `data/index.ts`/`usageFromDb.ts` which B also edits — stacking keeps them consistent.

## Per-PR specs

Each PR's detailed spec (files, exact changes, tests, done-criteria) is dispatched to its subagent inline, keyed to the finding IDs in `docs/reviews/2026-07-03-app-review.md`. Summary of intent below; the review doc is the authoritative finding source.

### A — Security (S1,S2,S4,S5,S6)
Add `src/middleware.ts` enforcing an Origin/Host allowlist (`localhost:4100`/`127.0.0.1:4100`) on all non-GET `/api/*` (and Host check on `/api/sql`, `/api/events`). Validate `port` is int 1–65535 in `api/dev-server/[slug]`. Add per-slug in-flight lock in `processManager.start`. Tests for middleware allow/deny + port rejection.

### B — Usage accuracy (A1–A7)
Include sidechain turns in totals (or a folded "subagent cost" line) in `parser.ts`+`ingest.ts`; local-day buckets in `aggregator.ts`/`usageFromDb.ts`; propagate user-turn intent onto assistant turns for category cost; parse `*_above_200k_tokens` tiered pricing; segment one-shot-by-category by session; dedup by `message.id`; fix cache-hit denominator. Fixtures + assertions for each.

### C — Scanner correctness (B1–B9)
Lowercase history-map + worktree keys; `watched.delete(slug)` on watcher error + parent-dir watch; detached-HEAD git fallback; distinguish git exec failure from clean; extend port regex; drop `.env.example` from DB-URL source; loosen manual-steps/board parser patterns; case-normalize lock key.

### D — Docs + dead code (C6,D4,D5)
Refresh CLAUDE.md route/scanner inventory; backfill CHANGELOG #239–#243; add help-mapping + docs for 7 routes (or hide "?"); delete unused `ComingSoonPage.tsx`; hide `analytics/health/schedule/timeline` stubs + unwired flags from nav/Settings.

### E — Infra (D1,D2,D6,D7,D8)
Move all `pnpm.overrides`+`onlyBuiltDependencies` into `pnpm-workspace.yaml`; CI: assert better-sqlite3 loaded (fail if DB suites skip), add Node 20/22 × ubuntu/windows matrix; document `setup-hooks` + add lint to hook; `git checkout tsconfig.json`; delete `nul`.

### F — Caches + perf (C3,C5)
Replace ad-hoc `globalThis` route Maps with a bounded LRU util + HMR dispose; add `dispose()`/generation guard to `skillUpdateCache`; batch catalog walks with scanner `BATCH_SIZE`; index sessions by slug once for grading.

### G — Test harness (D3)
Extend plan-005 API characterization harness across high-traffic routes; minimal component smoke suite; characterization test over `generateUsageReport`.

### H — RSC/SSE + pollers (C1,C2)
Validate each flag path, flip `rscHydration`/`serverActions`/`liveEvents` default-on; migrate bespoke `setInterval` pollers (`useEfficiencyGrades`, `useGitDirtyStatus`, `useGithubActivity`, `StatusDashboard`, `DevServerControl`, `SettingsPage`, `BackgroundActivityBrowser`) to `useQuery`/SSE; consolidate `ClaudeStatusBanner`+`ClaudeStatusListener` into one status provider.

### I — Backend unify + module split (C4,C7)
Single data interface with shared sort/merge post-processing over both backends' raw rows; split `db/ingest.ts` (reconcile/merge/write) and slice `types.ts` into domain modules; keep `data/index.ts` a thin façade.

## Status

| PR | Status |
|----|--------|
| A | TODO |
| B | TODO |
| C | TODO |
| D | TODO |
| E | TODO |
| F | TODO |
| G | TODO |
| H | TODO |
| I | TODO |

Updated live as the run proceeds.
