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

---

## Wave 4 — Pricing correctness (one coherent wave in `costCalculator`/`ModelPricing`)

All three touch the same pricing tier machinery and should ship together.

- **#393 — long-context tier leaves cache read/write at base rates.** `applyPricing` correctly selects the tier from the whole prompt, but only `inputRate`/`outputRate` switch to above-200k. **Blocked on external verification** of whether Anthropic doubles prompt-cache rates above 200k — confirm against current published pricing before coding. Do not guess.
- **#394 — scan-cache hits lose the per-turn tier split.** On the file-parse backend, `claude-stats.json` persists aggregate token counts only, so every subsequent cache hit re-prices at base rates. Displayed cost changes after the first scan and stays understated. Fix: persist the per-model tier split in the cache payload (cache-version bump).
- **TODO — pricing should consume `usage.speed` (fast mode).** Needs a fast-rate column per model in `ModelPricing`. Fast mode on Opus 5/4.8 is $10/$50 vs $5/$25 — double. **Currently unmeasurable locally:** across 1,200 transcripts / 10,742 assistant turns, `speed` was `standard` (10,288) or `null` (454) and *never* `fast`. Build it with a synthetic fixture before it silently matters.

---

## Wave 5 — Usage & session surfaces (small backend items)

- **TODO — `byCategory.oneShotRate` on the DB backend.** Documented as divergence #1 in `usageFromDb.ts` since P2b-2. `turns.task_outcome` removed the obstacle; it is now the same one-line `GROUP BY t.category` the effort panel already does. Closes a real backend divergence for near-zero cost.
- **TODO — Hook Activity source selector on the card.** `getHookActivity` prefers OTEL and falls back only on zero rows; since `since` is a *lower* bound, no period ever excludes recent events, so the transcript view is unreachable from the UI at every window including `all`. On this machine that hides 20.8k transcript-derived records keyed by *command* behind 81.1k OTEL records keyed by *hook name*. They measure different things and **must never blend** — the fix is an explicit source selector. The MCP half already shipped (`get-hook-activity(source: "transcript")`, 2026-08-07); this is the UI half only.
- **TODO — session segmentation, remaining surfaces.** `byEntrypoint` shipped on `/usage`, the Costs tab, and as a session-row chip. Still missing: a facet/filter on `/sessions` and `/background`, and portfolio stats still report one blended "cost per session". **The blend is the most misleading of the three** — an interactive session costs ~44× an SDK-driven one ($12.21 vs $0.28), so a single average describes neither. Split it.
  - *Reference caveat, keep in the doc:* source future corpus figures from the DB, not a file probe. The DB population includes 1,256 subagent transcripts a plain `~/.claude/projects/*/*.jsonl` walk never sees; the original file probe read 88% SDK-driven, nearly the opposite of the truth.
- **#395 — delegation caps miss nested spawns and searches.** `assessDelegation` is fed from session-summary fields that describe only the root session; the DB backend deliberately excludes sidechain rows (`is_sidechain = 0`). Needs a sidechain-aware session tree, not a call-site change — this is the M-sized item in this wave.

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
