# Backlog burn-down — full disposition

**Date:** 2026-08-08
**Scope:** every open GitHub issue (34) and every unchecked `TODO.md` item (22), each dispositioned exactly once.
**Goal:** drive the established backlog to zero, distinguishing *do-now*, *do-later-with-a-named-trigger*, and *decide-and-close*.

Baseline: `main` @ `0196d9c` (v1.9.1), 4,741 tests passing.

---

## Coverage ledger

All 34 open issues appear in exactly one wave below:

| Wave | Issues |
|---|---|
| W0 — Decisions | #30, #169, #170, #228, #229, #230, #231, #396 |
| W0b — **Already shipped, never closed** | #283, #288, #152, #153, #156, #157 |
| W1 — Next 16.3 + standalone | #284, #287 |
| W2 — Quick wins | #186, #188, #190, #236 |
| W3 — Test infrastructure | #331, #345, #355, #362, #273, #282, #220, #175 |
| W4 — Pricing correctness | #393, #394 |
| W5 — Usage/session surfaces | #395 |
| W6 — Accessibility | #391 |
| W7 — Service mode + build hygiene | #295, #296 |
| **Total** | **34** |

And all 22 unchecked `TODO.md` items appear in exactly one wave. Verify with `grep -c '^\s*- \[ \]' TODO.md` — the count must equal the total below.

| Wave | TODO items | n |
|---|---|---|
| W1 | Next.js ≥16.3 upgrade; cloud-endpoint spike | 2 |
| W4 | Pricing consumes `usage.speed` (fast mode) | 1 |
| W5 | `byCategory.oneShotRate` on DB; session segmentation surfaces; Hook Activity source selector | 3 |
| W8 | Project Groups P2 (aggregation); P3 (UI) | 2 |
| W9 | Widen `SessionAdapter` full text; approval UI + phone view; token-usage rule fields; project-scope config drift; per-task `scheduleAtQuotaReset`; quota threshold in config; embed only semantic queries | 7 |
| W10 | Fetcher + disk sync; `claude-cloud` adapter; attribution; distribution risk | 4 |
| W11 | Memory Observatory M.2 | 1 |
| Housekeeping | Capture `worktrees.png`; screenshot-without-prose PR check | 2 |
| **Total** | | **22** |

*The session-population caveat is deliberately **not** in this table — Wave 0 converted it from an unchecked checkbox into a reference note, because it was never actionable work. That is why the file's unchecked count is 22 rather than 23.*

---

## Wave 0 — Decisions (no code, unblocks 8 issues)

These are not engineering work. Each needs a call, then closes with a rationale comment. Batching them first is the single highest-leverage move in this plan: it removes ~24% of the issue count without writing a line.

| Item | The question | Recommendation |
|---|---|---|
| **#30 — rename to "Claudiscope"** | Rename or not? | **Close as won't-do.** Two years of docs, a published site, signed installers, an MCP server name, and a `project-minder` MCP namespace all carry the current name. The rename cost is now well above the benefit of a cuter name. |
| **#169 — Bumblebee integration** | Re-affirm or close? | **Close.** Deferred in the 2026-05 triage as Windows-blocked; nothing has changed. |
| **#170 — MS AI Engineering Coach integration** | Re-affirm or close? | **Close.** Deferred in the same triage: it's a VS Code extension whose value overlaps what Minder already surfaces. |
| **#396 — 18 residual Dependabot alerts** | Accept the residue? | **Keep open until W1 lands**, then re-triage: the Next 16.3 upgrade closes 4 (postcss). Close the remaining 14 with the "unreachable code path" analysis already written in the issue body as the rationale. |
| **#228 — worktree-scoped execution for promoted board tasks** | Schedule or park? | **Park with a trigger:** revisit when a promoted task actually needs isolation in practice. Label `parked`. |
| **#229 — typed Inbox items (Permission/Decision/Action)** | Schedule or park? | **Park.** Overlaps the approval-UI work in W9; fold in there rather than tracking twice. |
| **#230 — Operations panel follow-ups** | Schedule or park? | **Split:** the `OPERATIONS.md` write path is a real S-sized item worth doing (W8 candidate); ops MCP tools + live status are parked. |
| **#231 — GitHub activity follow-ups** | Schedule or park? | **Park with a trigger:** Octokit/PAT scale-up matters only when `gh` CLI rate limits actually bite. Manual-refresh is a small UI add that can ride along with any GitHub-strip touch. |
| **Code signing** (TODO) | Buy the Windows cert (~$120/yr Azure Artifact Signing)? | **Leave as a recorded decision, unchanged.** Apple side needs only `APPLE_*` secrets wiring if you ever want macOS signed for free-ish. Move this out of `TODO.md` into a decision record so it stops reading as outstanding work. |
| **Cloud-ingest distribution stance** (TODO) | Personal-only feature, or distributed to other installs? | **Decide before W10 starts.** Personal-only removes the credential-read/consent/eviction burden entirely and turns a large feature into a medium one. |

**Output:** 3 issues closed (#30, #169, #170), 4 labelled `parked` (#228–#231), 1 conditioned on W1 (#396), TODO items converted from work to decision records.

### W0 execution record — 2026-08-08 ✅

All four decisions taken as recommended. Open issue count **34 → 31**.

| Item | Outcome |
|---|---|
| #30 rename | **Closed** not-planned — name is load-bearing in the MCP namespace, installer identity, published site, help routes, and `~/.minder/` state paths |
| #169 Bumblebee | **Closed** not-planned — Windows-blocked; would ship untested by its own author |
| #170 AI Eng Coach | **Closed** not-planned — VS Code extension delivery-model mismatch + overlap with existing session analytics |
| #228–#231 | **Labelled `parked`** (new label) with a per-sub-item trigger comment. #229 folds into W9's approval UI; #230's `OPERATIONS.md` write path stays scheduled as a W8 ride-along, its other three sub-items parked |
| #396 | Comment records the closing condition: re-run alerts after 16.3.0 lands, confirm the 4 postcss clear, close with the existing unreachable-code-path analysis for the remaining 14 |
| Code signing | Moved out of `TODO.md` → `docs/decisions/2026-07-19-no-os-code-signing.md`; archived to `TODO.archive.md` as converted-not-completed |
| Session-population caveat | Converted from an unchecked TODO checkbox to a reference note — it was never actionable work |

---

## Wave 0b — Already shipped, never closed (6 issues)

**Found by the Codex review of this plan's own PR (#410), 2026-08-08.** Six issues in the 34-issue baseline were **fixed months ago and left administratively open**. Each was verified against the source, not just the CHANGELOG entry that named it — a CHANGELOG line can describe adjacent work.

| Issue | Verified in source |
|---|---|
| **#283** — MCP/proxy allowlist hardcodes 4100 | `src/lib/boundPort.ts` is now the shared helper; `mcp/server.ts:22` imports `buildAllowedHosts` from it, with a comment stating the two "cannot drift apart again". CHANGELOG:297. |
| **#288** — `claude-code-lint` unresolvable from server chunks | Resolved in a different shape than the issue proposed: the app `require.resolve`s the package.json and **spawns the bin as a CLI child** (`src/lib/lint/library.ts:39`), so `package-standalone.mjs:641-670` re-materialises the whole dependency subtree in npm layout and re-verifies every edge against the final tree with Node's real walk-up. CHANGELOG:326. |
| **#152** — `runningProcess: false` hardcoded | `resolveLiveness()` at `agentView/aggregate.ts:36-39` consults CLI liveness and returns a `livenessSource`. |
| **#153** — `cachedAt` stamped after fetch | `claudeAgentsCli.ts:113` stamps `sampledAt` captured *before* the call; the comment at `:101` names the original defect. |
| **#156** — drifted local `StatusPayload` | `StatusDashboard.tsx:12` imports the canonical type from `@/lib/liveStatus`; the local interface is gone. |
| **#157** — readdir-error early return vs. CLI cache | `liveStatus.ts` gained `transient` classification and a differentiated TTL for the CLI-unavailable case. |

All four (#152/#153/#156/#157) shipped together as the T1.1 follow-up cluster — CHANGELOG:797 names them explicitly.

**Why this matters beyond the six:** the burn-down's baseline was wrong by 18%, and no amount of internal consistency-checking would have caught it — the ledger only verified that every *listed* issue was scheduled, never that a listed issue was still real. **Standing correction: verify open-ness against the code before scheduling, not just against the issue's open state.** GitHub's open/closed flag is a claim about bookkeeping, not about the codebase.

**Real remaining work after W0 + W0b: 25 open issues, not 31.**

---

**Deliberately deferred (decided 2026-08-08):** the cloud-ingest distribution stance is **gated on the W1 spike**, not on W0. If the undocumented endpoints are dead upstream (simonw/claude-code-transcripts#77), the question is moot and answering it now would have been wasted. **Trigger:** the spike returning a live response schema — ask personal-only vs. distributed at that moment, before any of Wave 10 is designed.

---

## Wave 1 — Next.js 16.3 upgrade (the keystone)

**Why first:** tightest dependency node in the graph. It is the only path to 4 Dependabot alerts, and it is the precondition for the real #284 fix.

1. **Upgrade `next` `~16.2.12` → `^16.3.0`.** Deliberate own-PR upgrade, not a dependency chore — so a broken installer build is attributable.
2. **Re-apply `turbopackIgnore` annotations correctly** (#284). The method is fully written up in `TODO.md` and on the issue: the comment goes on the **`fs` call**, not the `path.join`; nested calls need it in both places. Enabling fix is upstream PR #94361, which landed in `16.3.0-canary`.
   - **Verify by entry count** in `.next/server/app/api/adapters/route.js.nft.json` — *not* by the build's warning count, which is noise.
   - Re-test the three pre-existing annotations in `db/migrations.ts`, `tasksDb/migrations.ts`, `serverRoot.ts` — they annotate `path.join` and are likely inert.
3. **If #284 resolves:** narrow the `outputFileTracingExcludes` list in `next.config.ts` (added by #338) back toward just `dist/` + `src-tauri/target`.
4. **Re-verify #287 against the new tracer** — Next's own tracer omits nested deps under `node_modules/next/node_modules/`. Upstream-tracer-shaped, so a tracer version bump may close or shrink it; if it survives, fix with an explicit backfill in `scripts/package-standalone.mjs`. (**#288 and #283 were already fixed** — see Wave 0b.)

**Gates:** `pnpm typecheck`, full test suite, **and `pnpm build`** (framework upgrade — build is non-optional here), plus an out-of-repo smoke test of `dist/minder-server`.

> ### W1 outcome — recorded 2026-08-09
>
> **Done:** Next `~16.2.12` → `^16.3.0`. Closes the 4 postcss alerts in **#396** (Next pins postcss *exactly*, so an override could never have reached it — the framework upgrade was the only path). Suite unchanged at 4,741 passing; typecheck, build, `package:standalone` and an out-of-repo smoke test (4 routes, all 200) all green.
>
> **Step 2 (#284) did not work, and is retired rather than deferred.** Upstream #94361 shipped in 16.3.0 and there is still no call site to annotate. Measured with the new `scripts/nft-census.mjs`: the sweep is per-route and strictly bimodal (124 routes trace 909 of `src/`'s 912 files, 89 trace zero, nothing between), so a partial fix is indistinguishable from no fix. Three candidate causes were tested and falsified — not a poisoned first-party module, not `better-sqlite3`/`bindings`, and no package separates the two groups. 16.3.0 also prints **zero** NFT warnings while the sweep is intact, so warning count is no longer merely noisy but actively misleading. Full data on #284; the follow-up is now a TODO item with a named next experiment.
>
> **Step 3 (narrow the excludes) is therefore void** — it was conditional on step 2 resolving. The list instead *grew*: `.env.local` and `.mcp.json` were being traced into `/api/health` and `/api/projects` and materialized in `.next/standalone`, stopped only by `package-standalone`'s prune on the way out; plus `agentlytics-repo/` (83 files, git-ignored sibling checkout). The node_modules invariant was re-checked and holds exactly (126 / 372 / 254 unchanged).
>
> **Step 4 (#287):** shrank from 9 missing nested deps to 4. Backfill still load-bearing; issue stays open.
>
> **Two new items found:** `instrumentation` bypasses `outputFileTracingExcludes` entirely (35,287-entry manifest including `.git/`, `tests/`, `docs/`) — latent, now a TODO; and **#413**, the packaged server serving nothing when `MINDER_USE_DB=0`.
>
> **The spike did not run** — it reads `~/.claude/.credentials.json` and calls an undocumented endpoint with a bearer token, which the permission classifier blocked. Script is written and ready. **W10 remains gated**, and the personal-vs-distributed decision is still unasked, as designed.

**Parallel side-quest (cheap, high information):** the **cloud-session spike** — ~60 lines, scratchpad only, outside the repo. Read org UUID from `~/.claude.json`, call `GET /v1/sessions`, dump the response shape. This gates 4 TODO items. If upstream issue simonw/claude-code-transcripts#77 means the endpoints are dead for everyone, an entire backlog section collapses to "closed, moot" — which is exactly what a burn-down wants to learn on day one, not month three.

---

## Wave 2 — Quick wins (one or two PRs)

Small, independent, high-confidence. Several have the fix pattern already established elsewhere in the codebase.

- **#186 — `prExtractor` empty-array fallback.** `[] ?? x` returns `[]`, so a top-level `tool_result` is skipped and PR URLs are silently dropped. The length-based fix already exists at `parser.ts:236-241` (shipped for tickets in #185). Copy it. Directly improves the `prSessionLinks` cross-link quality.
- **#236 — duplicate React keys on `/usage`.** Two duplicate `projectSlug` rows reaching `byProject`/`projectDetails`. Dev-only symptom, real data-correctness cause. Same class as #405 (skill-chip dedupe, just shipped) — dedupe at the aggregation source, not the render site.
- **#190 — `/api/usage` ETag omits a time component.** Rolling windows (24h/7d/30d/today) legitimately change as `now` advances without any mtime change, so a stale `If-None-Match` pins the UI. Add a time-slot component to the ETag salt.
- **#188 — usage help doc describes removed period semantics.** `docs/help/usage.md` + the `public/help/` mirror still document calendar-aligned "This Week (Sunday)". Pure docs.

*(The t1.1 cluster — #152/#153/#156/#157 — was originally scheduled here. All four shipped together long ago and were never closed; see Wave 0b.)*

---

## Wave 3 — Test infrastructure (8 issues, one enabler)

**#331 is the enabler — do it first.** 23 test files hand-roll the same three-step DB isolation (`spyOn(os.homedir)` → `resetModules()` → dynamic import). `DB_DIR` now checks `MINDER_STATE_DIR` ahead of `os.homedir()`, so running the suite with that env var set **defeats all 23 isolations at once**. Consolidate onto `tests/_helpers/` (extend the existing `mcpIsolation.ts`).

Then sweep the flaky cluster — several of these will close or shrink once isolation and a timeout policy land:

- **#345** — DB-fixture suites time out at 30s under `--pool=forks` on a loaded machine.
- **#362** — MCP/DB-heavy files time out under sustained local load.
- **#355** — `scannerSkippedRoots` "carries the previous successful scan forward" times out under parallel load.
- **#273** — verify-windows DB-parity tests fall back to file-parse before v3 reconcile completes.
- **#220** — `dataSessionsList` cost-estimate diverges 3× under the full suite, passes in isolation.
- **#282** — `configHistory` prune "collapses to one-per-day" fails at ~23:59 UTC (clock-boundary, not load).
- **#175** — 8–9s per "file backend" test is module-import overhead, not real directory walks.

**Guard rail:** per the working-practice note, verify each fix *discriminates* — mutate the implementation and confirm the test fails. Several tests in this repo have ratified defects or pinned an input order instead of the behaviour.


### Outcome — #331 (2026-08-09, branch `fix/w3-test-isolation`)

The enabler shipped in three commits. Two premises in the issue changed on contact:

| Claim in #331 | What the measurement showed |
|---|---|
| "23 test files" hand-roll the isolation | **30**, plus 20 more that spy `os.homedir()` for non-DB reasons (out of scope) and 9 that touch the DB layer without a dynamic import |
| Running with `MINDER_STATE_DIR` set "defeats all 23 isolations at once — measured at 24 failures" | **Already fixed.** `tests/setup/clearStateDirEnv.ts` (PR #332) deletes the variable in `setupFiles`, the only hook early enough. All 30 files pass with it set — verified, 30/30 |

So the remaining value was the duplication and the fact that a *new* file still binds silently to the real `~/.minder`. Delivered:

- `tests/_helpers/isolatedState.ts` — temp home + `HOME`/`USERPROFILE` + homedir spy + `MINDER_STATE_DIR` deletion + `globalThis` cache clear, with `reload()` for the per-test module reset. 31 files migrated onto it.
- `tests/dbIsolationGuard.test.ts` — enforcement. Walks the static import graph and asks whether a test can reach `db/connection` or `tasksDb/connection` along a path no `vi.mock` severs. **Derived, not listed**: a hand-written module list passed while missing `gradeSnapshot.test.ts`, one hop away.
- Both mutation-tested. That is what caught the guard's own worst bug — the graph followed only `@/` specifiers and was blind to `src/`'s 670 relative imports, so `@/lib/db/migrations` (which reaches connection as `./connection`) read as clean.

Two real defects fixed on the way: `gradeSnapshot.test.ts` froze `DB_DIR` before its own isolation ran, and `tasksDbConnection.test.ts` bound to the real `tasks.db`, safe only by an argument asserted nowhere.

Eight files carry a documented allowlist entry — each states why it cannot open the developer's real database, and a staleness check fails if one stops needing the exception.

### Outcome — the flaky cluster (2026-08-10, branch `fix/w3-flaky-cluster`)

Three of the seven issues proposed raising timeouts or tuning the pool. Measurement said the cost was elsewhere, and once it was removed no timeout policy was needed at all.

**#175 — premise corrected.** The issue attributed ~9s per "file backend" test to `vi.resetModules()` forcing a re-import in every `it()`. Measured, a reset + re-import costs **23ms**: `resetModules` clears only transformed source, so externalized deps are never re-executed. The real cost was a once-per-fork cold load, so the issue's fixes 2 and 3 would have saved ~0ms. Profiling the graph found one carrier — `contributionCalendar` importing the `date-fns` **barrel** (~700 modules, 2187ms). `next.config.ts` already lists date-fns under `optimizePackageImports`, so production never paid it; the vitest module runner has no equivalent. Four deep subpath imports:

| | before | after |
|---|---|---|
| cold `@/lib/data` import | 3306ms | 1814ms |
| per-test "file backend …" | 3808ms | 2044ms |

**#220 — mechanism found, but not the one in the issue.** The pricing disk cache resolves under `resolveStateDir()` = `MINDER_STATE_DIR || process.cwd()`, and the suite deletes that variable, so the cache path was **the repo root**: runs read, and on a miss wrote, a 1.2 MB `.cache/litellm-pricing.json` beside the source. Where absent (every CI runner) pricing came off the network once per `vi.resetModules()` — **221 requests to raw.githubusercontent.com in one measured run**. A fork whose fetch lost silently used `FALLBACK_PRICING` while its siblings used live rates. New `MINDER_PRICING_FILE` seam pins pricing to a committed 26 KB fixture; suite verified with all `fetch` rejected and the cache removed: **0 network attempts**, previously 221 plus a failure. Not claimed as *the* #220 fix — its exact 3.0× ratio is equally consistent with a turn-count difference, and fixture and fallback agree on the models that parity test exercises. Pricing is removed as a variable.

**#282 — fixed as diagnosed.** `prune` buckets by UTC calendar day, and the test derived a "same day" sibling as `Date.now() - 2d + 60_000`, true only more than 60s from UTC midnight. Anchored to a fixed mid-day instant, plus a new case asserting the straddle-midnight behaviour deliberately. Mutation-tested both directions.

**#273 — diagnosis improved, cause still open.** `reconcileAllSessions` counts per-file failures in `stats.errors` rather than throwing, and clears the v3 readiness gate only at zero — so the façade serves file-parse and the failure surfaces later as a parity divergence. All 18 façade call sites discarded those stats. `assertReconcileClean` now asserts it at the setup line; verified by forcing an error and confirming the message names the gate. **Why reconcile errors on the Windows runner is still unknown** and not reproducible locally.

**#345 / #362 / #355 — no timeout policy needed.** After the two fixes above, the exact tests these issues name run at 1.8–2.7s against a 30s ceiling (11–16× headroom). Reproduced their condition directly — full suite with 12 of 16 cores saturated — reaching **2.8× inflation**, matching the 2.5× and 2.4× the issues report, with **zero timeouts and 4,827 passing**. Raising the ceiling would have hidden 221 network round-trips inside test bodies rather than removing them.

Full suite **61.19s → 45.59s**; import 78.87s → 55.74s; test time 179.34s → 100.0s.

Also of note: the `dbIsolationGuard` shipped with #331 caught a file written *after* it — `pinnedPricing.test.ts`, whose loop-based env restore it cannot verify. Rewritten in the per-key form rather than relaxing the guard.

---

## Wave 4 — Pricing correctness (one coherent wave in `costCalculator`/`ModelPricing`)

All three touch the same pricing tier machinery and should ship together.

**Shipped 2026-08-10** — all three, in one branch, sequenced internally.

- **#393 — long-context tier leaves cache read/write at base rates.** ✅ **Closed.** The external verification the plan demanded turned out to be impossible in the form it asked for: Anthropic **no longer publishes a long-context rate table**, because the tier only ever applied to the Sonnet 3.5→4.5 lineage and those models are retired from the first-party API. Verified by derivation instead — the page still states cache multipliers are "relative to base input token rates" (0.1× / 1.25× / 2×) and "stack with other pricing modifiers", which against Sonnet 4.5's $6 above-200k input gives $0.60 / $7.50 / $12.00, digit-for-digit LiteLLM's three `*_above_200k_tokens` cache fields. Two independent routes, identical numbers. **Blast radius, measured: zero turns on this corpus** — of 102,179 priced turns, none with a >200k prompt is on a tiered-lineage model; all 47,912 long-prompt turns are flat-priced Opus/Fable/Sonnet-5.
- **#394 — scan-cache hits lose the per-turn tier split.** ✅ **Closed**, and it was bigger than the title. A cache hit lost the **model** too (everything attributed to `unknown`, priced as Sonnet — on an Opus-heavy corpus the dominant error, larger than the tier one it was filed for) and the **1-hour cache-write TTL**. Per-model/per-rate split now persisted at cache version 2; v1 entries discarded rather than migrated.
- **TODO — pricing consumes `usage.speed` (fast mode).** ✅ **Done.** Hardcoded `FAST_PRICING` ($10/$50 on Opus 5 / 4.8), since LiteLLM carries `supports_speed` but no rates. Still never observed locally, so tested on a synthetic fixture — the point of building it early.

**Two things the wave surfaced that the plan did not anticipate.**

1. **Speed had to be a bucket dimension, not a lookup flag.** `PerModelTokens` is keyed per-(model, tier); a fast turn folded into a shared bucket is unrecoverable at pricing time, so without a third bucket fast turns mispriced on *fresh parse* too, not only on cache hits. Since #394 persists exactly that structure, getting this wrong would have meant a cache v3 inside the same PR. It dictated the build order: rates → speed → bucket restructure + cache v2.
2. **`DERIVED_VERSION` 17 → 18 was required and is invisible to tests.** `turns.cost_usd` is stamped at ingest, so a formula change leaves old rows holding old numbers — and no test can see it, because a test always ingests with current code. Only a real user's existing DB carries them. Unbumped, the file-parse backend heals (cache v2) while SQLite does not, which is the #220 parity class. Bumped despite provably changing zero rows here, on the grounds that the constant's rule is unconditional and a corpus-specific exception is how it stops being trustworthy.

**Guard rail: 10 mutations run, 2 survived and both became tests.** Dropping the tiered cache fields from `parseLiteLLMEntry` failed nothing (every test either built `ModelPricing` by hand or forced the offline fallback — the parse path was unpinned), and dropping the rule-overlay scaling for the new cache rates failed nothing either. A third finding is recorded rather than fixed: on all real data both tiered write rates are exactly 2× their base, so a shared-ratio and a per-rate implementation are indistinguishable — that test needs a deliberately asymmetric synthetic fixture, and says so.

**One pre-existing test had ratified the defect.** `longContextTier.test.ts` pinned cache reads at the *base* rate inside the long tier and passed — on the exact turn shape where cache is ~98% of the bill. Corrected.

**Bot review found four more defects across three rounds, and three shared one shape: a second copy of logic that had drifted from the first.** `scanSessionFile` keeps its own token accumulation for the session list and was not passing `speed`; `sessionQuality`'s cache rebuild-waste read `ModelPricing`'s base fields directly, so it ignored the tier, fast mode *and* the 1-hour TTL (the last understating it ~37% on every real session, and pre-dating this wave); and the 1-hour tiered rate had its own fallback branch that reached for a base rate. Round 1's response consolidated rate selection into one exported `selectEffectiveRates` rather than patching call sites, which is why round 2 produced a single finding and round 3 none. The fourth was a real race in a new test (un-awaited scan against a cache rewrite), caught by Copilot.

The 1-hour finding is the one worth carrying forward as technique: the broken fallback priced the **1-hour TTL cheaper than the 5-minute one**, which is impossible — 2× base input against 1.25×. That ordering is structural, so the bug was provable without knowing a single published rate, and the invariant is now asserted across every model in the pinned table. *Prefer an invariant that holds for all inputs over a literal that pins one.*

Merged as `c49d2b7` (PR #423), 4 commits. Open issues 18 → 16.

---

## Wave 5 — Usage & session surfaces (small backend items)

- **TODO — `byCategory.oneShotRate` on the DB backend.** Documented as divergence #1 in `usageFromDb.ts` since P2b-2. `turns.task_outcome` removed the obstacle; it is now the same one-line `GROUP BY t.category` the effort panel already does. Closes a real backend divergence for near-zero cost.
- **TODO — Hook Activity source selector on the card.** `getHookActivity` prefers OTEL and falls back only on zero rows; since `since` is a *lower* bound, no period ever excludes recent events, so the transcript view is unreachable from the UI at every window including `all`. On this machine that hides 20.8k transcript-derived records keyed by *command* behind 81.1k OTEL records keyed by *hook name*. They measure different things and **must never blend** — the fix is an explicit source selector. The MCP half already shipped (`get-hook-activity(source: "transcript")`, 2026-08-07); this is the UI half only.
- **TODO — session segmentation, remaining surfaces.** `byEntrypoint` shipped on `/usage`, the Costs tab, and as a session-row chip. Still missing: a facet/filter on `/sessions` and `/background`, and portfolio stats still report one blended "cost per session". **The blend is the most misleading of the three** — an interactive session costs ~44× an SDK-driven one ($12.21 vs $0.28), so a single average describes neither. Split it.
  - *Reference caveat, keep in the doc:* source future corpus figures from the DB, not a file probe. The DB population includes 1,256 subagent transcripts a plain `~/.claude/projects/*/*.jsonl` walk never sees; the original file probe read 88% SDK-driven, nearly the opposite of the truth.
- **#395 — delegation caps miss nested spawns and searches.** `assessDelegation` is fed from session-summary fields that describe only the root session; the DB backend deliberately excludes sidechain rows (`is_sidechain = 0`). Needs a sidechain-aware session tree, not a call-site change — this is the M-sized item in this wave.

### W5 outcome — the small backend items (2026-08-10, branch `feat/w5-usage-surfaces`)

Three of the four items were taken; **#395 is deliberately held for its own PR** (M-sized, different machinery, and W4's lesson was that a coherent review surface keeps bot rounds short).

- **`byCategory.oneShotRate`** ✅ **Done — and the plan mis-stated it.** This was not "fill in a field the DB backend skips". The *file* backend's definition was broken: it sliced each category's turns out of the session and re-ran the detector over the slice, but the classifier files the edit under `Coding` and the `pnpm test` that judges it under `Testing`, so every ordinary task was split across two slices and neither half formed a task. Implementing the plan as written would have copied that into SQL. Verified by probe before writing anything: on a textbook edit→verify session the headline reported 1 one-shot task and **no category reported any rate**. The only tasks that survived slicing were ones whose edit and verification classified identically — in practice just test-file edits verified by a test command. Both backends now anchor on the turn that *started* the task, which is what `byEffort`, `bySkill` and `turns.task_outcome` already do, so the definition is cheap on both sides and the divergence closes as a by-product. Measured: 5 of 13 categories go from no rate to a real one over 1,699 verified tasks, and the figures separate (`Refactoring` 92.1% vs `Debugging` 78.3%). No `DERIVED_VERSION` bump — read-time only.
- **Hook Activity source selector** ✅ **Done**, exactly as scoped (UI half only; the query layer already took `source`). Route validates `auto|otel|transcript` and **400s** an unrecognized value rather than coercing to `auto` — the pipelines count different things, so a fallback answers a different question under the requested label. The toggle renders above the empty and error branches so choosing an empty source is reversible.
- **Session segmentation** ⚠️ **One of three sub-items shipped; the other two were stale premises, corrected with evidence rather than built around.**
  - *Facet on `/sessions`* ✅ **Done.**
  - *Facet on `/background`* ❌ **Not applicable.** `/background` is not a session surface. It renders `background_tasks` / `session_crons` harvested from Stop/SubagentStop hook payloads, keyed by **project**, out of a 5-minute in-memory ring buffer. There are no session rows and no `entrypoint` field to facet on. (Resisted the temptation to substitute a `bg` session-kind filter: `entrypoint.ts` explicitly keeps `bg` off the entrypoint axis as an orthogonal flag, so that would have been scope invented to avoid reporting a stale premise.)
  - *Split the blended "cost per session" in portfolio stats* ❌ **No such figure exists.** Searched `avgCost|costPerSession|perSession|averageSession` across `src/lib`, `src/app/api` and the MCP tools: the only per-session cost in the codebase is `byEntrypoint.avgCostPerSession`, which is **already** split by entrypoint and already rendered by `EntrypointPanel` on `/usage` and the Costs tab. `/stats` shows session count and total cost as separate cells and never divides them. The split this asks for shipped with `byEntrypoint`.
- **#395** — not started. The two pre-design checks stand: confirm whether sidechain rows share `session_id` with `is_sidechain = 1` (read-time aggregate, no version bump) or are child session rows; and confirm what `subagentCount` counts on *each* backend before defining the roll-up, or the fix ships a new divergence in place of the old one.

**The segmentation numbers, re-measured** (the plan's figures were from 2026-08-05 and the corpus has grown): interactive `cli` costs **$13.43**/session against `sdk-cli`'s **$0.22** — the gap widened from 44× to **61×** — and the inversion sharpened: **69%** of 6,024 sessions are SDK-driven and account for **4%** of the spend. Direction held across both measurements, which is what matters; the multiple on any one day does not. Sourced from the index, per this wave's own standing caveat about file probes.

**Guard rail: 5 mutations run, 1 survived and became a test.** `queryByCategory` has two SQL bodies and only the `category_costs` rollup one was covered — the source/home-filtered body could drop the rate entirely with the suite green. Caught by mutation, pinned by a `?source=` read. *A function with two implementations of the same contract needs a test per branch, not per function.*

---

## Wave 6 — Accessibility (#391)

Follow-up to #380/#390. The `.sr-only` + `aria-hidden` pattern reached screen readers but **not** sighted keyboard users (`.sr-only` is visually clipped; `title` doesn't appear on focus in any major browser) or touch users (no hover, nothing to tap). The remedy is a shared tooltip primitive that opens on hover **and** focus **and** tap, then migrating the load-bearing `title=` usages onto it. Medium: one primitive, then a mechanical sweep.

---

## Wave 7 — Service mode + build hygiene

- **#295 — `tauri-build` `rerun-if-changed` over `dist/minder-server` makes `cargo build`/`clippy` ~2 min.** Narrow the watched path set. Pure DX, but it taxes every Tauri iteration.
- **#296 — `MINDER_BOOTSTRAP=0` shutdown runs ~0 disposers.** Ingest and the dispatcher still start, but disposers are only registered by `runBootstrap`, so the "don't bootstrap" mode leaks. Register disposers independently of the bootstrap flag.

---

## Wave 8 — Project Groups P2 → P3

Fully spec'd; prerequisites shipped 2026-07-20/21. Spec: `docs/superpowers/plans/2026-07-20-project-groups-multi-location.md`.

- **P2 — aggregation layer.** Pure `aggregateGroup(members)` with four merge rules: repo-borne files **dedupe** (insight/issue IDs are stable; TODO items need content hashing) and surface divergence as signal; activity **sums**; location-bound state (branch, dirty, dev server, worktrees) **never merges**; environment-borne catalogs **diff**. Derived rates must recompute over the union — averaging two one-shot rates weights a 3-session location like a 100-session one. **This is where double-counting bugs live; test heavily.**
- **P3 — UI.** Group card with a `2 locations` chip, Locations strip, divergence flags on repo-borne tabs, per-location breakdown under every aggregate, and an Environments tab comparing skills/agents/MCP across Claude homes. URL space is decided: separate `/group/<slug>` namespace, so a group/project slug collision is intended. A group of one must render exactly as today.

*Optional ride-along:* the `OPERATIONS.md` write path split out of #230 — it's the same "canonical-resolve → lock → atomic write → re-parse" shape as `boardWriter`.

---

## Wave 9 — Session-tooling deferred halves

Seven TODO items, all deferred halves of shipped work. Roughly ordered by value.

1. **Approval UI + LAN phone view.** API surface and safety properties are done and tested; the dashboard approval card and `/phone` view are not, which is why `blockingApprovals` ships default-off. #356 shipped the `PreToolUse` hook registration and Setup prompt (discoverability half). The answer-it-from-a-phone half is what remains. **Fold #229 (typed Inbox items) in here.**
2. **Widen `SessionAdapter` to carry full text.** `adapters/utils.ts` `TEXT_CAP = 500` caps text *inside* the adapter, before ingest, so full-body FTS covers Claude only. Contract change across all adapters + a `DERIVED_VERSION` bump — the cost is the re-index, not the code.
3. **Token-usage rule fields.** Hook payloads carry no token counts, so `contains`/`gt` over cost or context fill isn't expressible in the hook-evaluated engine. Needs a polling evaluator over `aggregator.ts` feeding the same `matchRules` + cooldown path, so rules stay one concept with two trigger sources.
4. **Project-scope config drift.** A repo's own `CLAUDE.md` vs `AGENTS.md` vs `.cursor/rules`, and `.mcp.json` vs a project-level Codex config. Cheap now that the compare layer is kind-agnostic, but needs a per-project inventory source and a decision about where findings hang (per-project lint report, not the global pass).
5. **Embed the query only when it looks semantic.** Every search pays ~20 ms of model inference when `semanticSearch` is on, including for a plain filename or slug where BM25 already wins.
6. **Per-task `scheduleAtQuotaReset`.** The gate is global — it holds the whole queue. An explicit per-task affordance would set `scheduled_for` from `resetAt` at creation time.
7. **Expose the 0.98 quota threshold in config.** Currently a constant with a test-only options param. Do this only if the default proves wrong in practice — deliberately not invented up front.

---

## Wave 10 — Cloud session ingest (gated on the W1 spike)

**Only proceed if the spike says the endpoints live.** The spike's real output is the **response schema** — `session_ingress` almost certainly does not return the local JSONL shape, and that mapping layer is the actual work.

1. **Fetcher + disk sync** — `src/lib/cloudSessions/fetcher.ts`, modelled on `githubActivityCache`: `globalThis` singleton, TTL, `available:false` sentinel with a reason enum, never throws, never blocks a scan. **No background poller** — sync on explicit user action plus opportunistically on project-detail open. Materialize to `~/.minder/cloud-sessions/projects/<slug>/<sessionId>.jsonl`, same on-disk layout as a real Claude home, so a broken endpoint degrades to *stale but present* rather than *gone*.
2. **`claude-cloud` adapter** — thin; reuses `parseSessionTurns` verbatim, tags `source: "claude-cloud"`. Deliberately not a network adapter: `SessionAdapter` is filesystem-shaped, and syncing to disk preserves that contract instead of widening the interface for one caller.
3. **Attribution — strict + explicit fallback.** Only join key is `owner/repo` → scanned `remoteUrl` (reuse `parseGitHubRemote`). Attribute only on exact match; everything else lands in an "unattributed" bucket for manual assignment, persisted in `.minder.json`. **Rejected: fuzzy matching** — a mis-attributed session silently corrupts a project's `/costs` number, which is worse than a missing one.
4. **Distribution risk** — **still undecided by design** (W0, 2026-08-08). The personal-only vs. distributed question is answered *immediately after the spike confirms a live schema*, before anything here is designed — because it is the difference between an M and an L. If distributed: default-off `FeatureFlagKey` with `githubActivity`-level discipline, an explicit consent string naming the credential file read and the transcript storage location, a retention/eviction policy, and hard graceful degradation on endpoint change. Note that reading `~/.claude/.credentials.json` **violates the invariant stated in `src/lib/adapters/types.ts`** ("Auth/credential files are never read") — a fine personal choice, a changed promise when distributed.

---

## Wave 11 — Memory Observatory M.2 (last; needs upstream research first)

The only remaining Memory Observatory wave. **Not startable as spec'd** — it opens with three unanswered research questions: (a) Codex's exact memory layout under `$CODEX_HOME/` and its `MemoriesUsageKind` enum values, (b) whether Gemini has a memory equivalent at all on Windows, (c) taxonomy mapping between Claude's `feedback_*`/`project_*`/`reference_*`/`user_*` and Codex's structure.

**Recommendation: split M.2a (read-only, three-column diff view) from M.2b (write/push).** M.2a is deliverable from the research alone and is where most of the value sits — seeing divergence is the thing you can't do today. M.2b's conflict-resolution UI and per-harness body-syntax translation are a second, larger decision.

Plan doc: `C:\Users\joshu\.claude\plans\i-recently-read-this-temporal-crane.md`.

---

## Housekeeping (ride-alongs, no dedicated wave)

- **Capture `worktrees.png`.** Mechanism shipped 2026-06-29 — `capture-screenshots.mjs` step 15 self-discovers a project with an active worktree overlay and skips cleanly when none exists. **Needs a live worktree:** with an active `*--claude-worktrees-*` present, run `pnpm capture:docs`, then point `site/index.html` (~line 105) at the new file. It currently honestly shows `todos-tab.png`. **Do this during any wave that creates a worktree** — most of them will.
- **PR check warning on screenshot-without-prose changes.** Light-touch workflow on PRs touching `site/**`: fail or comment if `site/screenshots/*.png` changed without a `site/index.html` diff. A single grep over `gh pr diff --name-only`.

---

## Recommended first move

**Wave 0 (decisions) + Wave 1 (Next 16.3) + the cloud spike, in that order within a single session.**

Wave 0 is conversation, not code — it costs one pass and removes 8 issues from the count. Wave 1 is a single focused branch whose verification steps are already written down. The spike runs in the background of Wave 1's slow build and tells us whether an entire backlog section is even real.

Wave 2 (quick wins) can run as a parallel branch — it touches none of the same files.

**Standing gates for every wave:** `pnpm typecheck` → full test suite → `pnpm build` when `src/` is touched. Never pipe a gate's output through a filter; redirect to a file and check `$?`. Only one `pnpm build` at a time.
