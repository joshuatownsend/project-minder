# Backlog burn-down — full disposition

**Date:** 2026-08-08
**Scope:** every open GitHub issue (34) and every unchecked `TODO.md` item (22), each dispositioned exactly once.
**Goal:** drive the established backlog to zero, distinguishing *do-now*, *do-later-with-a-named-trigger*, and *decide-and-close*.

Baseline: `main` @ `0196d9c` (v1.9.1), 4,741 tests passing.

> ⚠️ **The Scope line above, and both ledger tables and the `grep -c` invariant below, are the 2026-08-08 baseline and no longer hold.** For current figures see [Status reconciliation — 2026-08-14](#status-reconciliation--2026-08-14), which supersedes them and restates the invariant. Do not run the top-of-doc self-check expecting it to pass; it is a historical record, not a live assertion.

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

And all 22 unchecked `TODO.md` items appear in exactly one wave. Verify with `grep -c '^[[:space:]]*- \[ \]' TODO.md` — the count must equal the total below. *(Pattern corrected 2026-08-14: this originally used `\s`, which is a GNU extension and matches a literal `s` under POSIX grep. It happened to give the right answer only because no checkbox is indented — a self-check that works by luck, which is the failure this doc keeps finding elsewhere.)*

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

## Status reconciliation — 2026-08-14

**Both ledgers above are the 2026-08-08 baseline and are now stale.** This section supersedes them; the per-wave outcome blocks below remain the record of *how* each wave went.

Open issues: **34 → 22**, of which **4 are `parked`** (#228–#231) and **1 is a standing gate rather than schedulable work** (#432). Real remaining: **17 issues across 5 waves.**

### ⚠️ Standing caveat — this document's causal claims are weaker than its observations

**Treat every "X is caused by Y" / "X is blocked on Y" statement here as unverified until someone opens the relevant file.** Four rounds of review on this plan's own PR (#447) found the same defect four times, and it is worth stating plainly because only the instances a reviewer happened to check got corrected:

| Claimed | What the source said | Caught in |
|---|---|---|
| Demo mode leaks the real burn %, MCP health, and skill slugs | All three are fixtures; their routes are guarded (`src/lib/demo/`) | Round 1 |
| #445 is W12's enabler — *empty* vs *still loading* is externally undetectable | `waitForStableUI` already detects all four idioms (`capture-screenshots.mjs:220-254`) | Round 2 |
| #296 shares the tracing batch's verification loop | It is a runtime lifecycle defect the packaging loop cannot observe at all | Round 3 |
| `/analytics` is slow for the same reason as #439 | It is a static `ComingSoon` page that fetches nothing | Round 4 |

The 2026-08-12 route audit and the wave records **observed** accurately — the symptoms are real and reproducible. What was unreliable is the layer above: explanations attached to those symptoms by inference, written from what the behaviour looked like rather than from the code, then propagated into sequencing decisions ("do this first", "check that wave first", "batch these together"). Three of four such claims examined were wrong, and one of them had reordered an entire wave.

**Practical rule for anyone executing a wave from this doc:** the issue numbers, measurements, and file:line references were checked. The *because* clauses were not. Before inheriting a dependency or an ordering, open the file — the cost is one read, and the failure mode is an investigation aimed at the wrong subsystem. This is the same family as the gates recorded elsewhere in this plan that ran, passed, and proved nothing.

### Wave status

| Wave | State | Notes |
|---|---|---|
| W0 — Decisions | ✅ Done 2026-08-08 | 3 closed, 4 parked |
| W0b — Shipped-never-closed | ✅ Done 2026-08-08 | 6 closed |
| W1 — Next 16.3 | ✅ **Resolved 2026-08-18** | Shipped → reverted to `~16.2.12` in v1.10.1 → un-pinned to `~16.3.1` after the gate ran in both directions; see the W1 REVERTED and W1 RESOLVED blocks. #284 retired on its own evidence, #287 survives, #413 found here |
| W2 — Quick wins | ✅ Done | #186, #188, #190, #236 all closed |
| W3 — Test infrastructure | ◐ **Mostly done** | #331, #345, #355, #362, #282, #175 closed; **#273, #220 still open**, and #421 + #430 joined the family after the baseline |
| W4 — Pricing correctness | ✅ Done 2026-08-10 | #393, #394 closed; `DERIVED_VERSION` 18 |
| W5 — Usage & session surfaces | ✅ Done 2026-08-10 | #395 closed; #426 found and fixed unplanned (v19) |
| W6 — Accessibility (#391) | ⬜ Not started | |
| W7 — Service mode + build hygiene | ⬜ Not started | Grew from 2 issues to 6 — see the addendum |
| W8 — Project Groups P2→P3 | ⬜ Not started | |
| W9 — Session-tooling deferred halves | ⬜ Not started | |
| W10 — Cloud session ingest | ✅ **Closed as moot 2026-08-15** | The spike ran and returned a controlled negative — the endpoints no longer exist. All 5 TODO items archived |
| W11 — Memory Observatory M.2 | 🔒 Gated on upstream research | |
| **W12 — Demo-mode coverage** | ⬜ **New** | |
| **W13 — Index-backed reads & aggregation correctness** | ⬜ **New** | |

**One phrasing correction to carry forward:** #396 is *closed*. What re-opened with the v1.10.1 revert are the four **postcss Dependabot alerts** it tracked — the issue itself stays closed, and a future Next bump is what clears the alerts.

### Ledger addendum — the 10 post-baseline issues

The baseline dispositioned 34 issues. Ten more were filed between 2026-08-09 and 2026-08-14 and had no wave. Each gets exactly one, same discipline as the original ledger:

| Issue | Wave | Why there |
|---|---|---|
| #441 — demo mode leaks real data on `/workflows` | **W12** | Named in `TODO.md`'s demo-mode section as one of the two already-filed instances of a single coherent gap |
| #443 — demo mode `/usage` throws "circular link", renders the browser error page | **W12** | Same gap; the only one that fails *hard* rather than leaking |
| #445 — three loading idioms, none externally detectable | **W12** | Maintenance value within the wave, **not** a prerequisite — the detector that covers all four idioms is a hand-maintained list that has to track them. *Originally filed here as the wave's enabler; corrected 2026-08-14, see W12 item 6.* |
| #439 — Hot Files / File Coupling parse all session JSONL instead of the index | **W13** | |
| #425 — session facets applied after the FTS top-200 cut | **W13** | Same shape: the index can answer correctly and the read layer doesn't ask it to |
| #416 — `byProject` splits a macOS project across two path casings | **W13** | The wave's quick win; the case-folding pattern already exists in the scanner from #249–257 |
| #421 — tests delete inherited env vars without restoring them | **W3 residue** | Same family as #273/#220 — cross-test interference, not a product defect |
| #430 — `verify-windows` teardown exceeds the 10s hook timeout | **W3 residue** | |
| #413 — packaged standalone serves nothing when `MINDER_USE_DB=0` | **W7** | *Found and recorded in the W1 outcome block, never dispositioned* — this is its first scheduling, not a second discovery |
| #417 — derive tracing/hygiene exclusion lists from `.gitignore` | **W7** | Directly about the `outputFileTracingExcludes` list W1 grew by hand |

**Also re-homed:** #284 and #287 were W1's issues. W1 is void, #284's wave-scale fix is retired (it survives as a `TODO.md` item with one named next experiment), and #287's backfill is still load-bearing. Both are build-tracing shaped, so **both move to W7**, which is now the single place build hygiene lives.

W7 therefore reads: **#295, #296, #413, #417, #284, #287.**

### TODO invariant, restated

> **This section is the only place either count is stated.** The warning at the top of the file used to restate them too, and drifted within a day of being written — the callout whose job is to stop readers trusting a stale figure was itself carrying one (caught by Codex on PR #448, the fourth time in this series a number was fixed in one place and left stale in its mirror). It now points here instead of repeating. Add a count to a third location and this recurs; the tables below plus `grep -c` are the whole contract.


The original table asserted `grep -c '^[[:space:]]*- \[ \]' TODO.md` = 22. **It was 27 at reconciliation, and is 22 since W10 was archived on 2026-08-15**, and the composition changed on both sides — an unexplained count is what breaks this doc's self-check, so here is the delta.

*Left the file (completed):* W4's `usage.speed` pricing item (1), W5's three items (3), W1's "upgrade to Next ≥16.3" (1, rewritten rather than closed — see below), and the screenshot-without-prose PR check (1, shipped as `.github/workflows/site-screenshots-check.yml`, archived 2026-08-12). **−6.**

*Entered the file:* six demo-mode findings — five from the 2026-08-12 route audit plus the `/stats` cross-check leak added 2026-08-14 during this plan's own review (**W12**), the `DERIVED_VERSION`-needs-the-worker-fix release gate, the #432 re-test-before-un-pinning gate, the `instrumentation` exclusion bypass, the export-filename helper extraction, and the rewritten #284 next-experiment item. **+11.**

Current distribution — this is the table to verify against:

| Wave | TODO items | n |
|---|---|---|
| W8 | Project Groups P2 (aggregation); P3 (UI) | 2 |
| W9 | Widen `SessionAdapter` full text; approval UI + phone view; token-usage rule fields; project-scope config drift; per-task `scheduleAtQuotaReset`; quota threshold in config; embed only semantic queries | 7 |
| ~~W10~~ | ~~Endpoint spike; fetcher + disk sync; adapter; attribution; distribution stance~~ — **all 5 archived 2026-08-15, endpoints gone** | 0 |
| W11 | Memory Observatory M.2 | 1 |
| **W12** | ~18 empty screens; finish triaging the API-route tail; build a synthetic tasks DB; `/analytics` never loads; Home's `0 projects` header | 5 |
| Housekeeping | #284 next experiment; `instrumentation` bypass; capture `worktrees.png`; extract export-filename helpers; hot-files/file-coupling cache watermark (#454) | 5 |
| **Total** | | **20** |  *(27 at reconciliation; W10's 5 archived 2026-08-15; the `DERIVED_VERSION` gate archived 2026-08-18; the #432 re-test gate archived 2026-08-18. The W12 and Housekeeping rows were also stale against `TODO.md` independently of those archivings — W12 still listed three demo-mode leak items shipped 2026-08-16, and Housekeeping omitted the #454 watermark item; both are corrected here, which is why the row totals moved by more than the one archived gate.)*

*The cloud spike moved from W1 to W10 in this table. The 2026-08-08 version counted it under W1 as a parallel side-quest; it never ran there, and it gates only W10, so it is counted where it belongs.*

### Three standing items that are not waves

They block or condition other work and have no home in the wave sequence:

1. ~~**The cloud spike needs you, not a wave.**~~ ✅ **Ran 2026-08-15 — and it did delete an entire section.** `GET /v1/sessions` returns 404 `not_found_error`, identical to a bogus control path, while the same token and headers get 200 from `/v1/models`. W10's 5 TODO items are archived and the personal-vs-distributed decision is permanently moot. It was indeed the cheapest question in the backlog: one script, one run.
2. ~~**No `DERIVED_VERSION` bump ships without the worker-ingest fix (#431 / PR #435).**~~ ✅ **Discharged 2026-08-18 — the fix shipped.** `80dac0e fix(package): host ingest in the worker thread by default (#435)` is in **v1.11.0**, published 2026-08-17, so any install that takes a future bump already runs ingest off the main thread and the forced re-parse can no longer blackout the dashboard. The bump itself is still deliberately unshipped, but that is now a scheduling choice rather than a safety gate. Archived out of `TODO.md` in the same pass.
3. **#432 gates every `next` bump**, including a routine Dependabot PR. **Still true after 2026-08-18** — the bump to `~16.3.1` cleared the gate, but the root cause was never found, so the four-cold-boot probe (written up in the W1 REVERTED block, with a third trap added in W1 RESOLVED) governs the *next* bump too.

### Recommended order from here

**W12 → W6 → W7 → W13 → W3 residue**, then W8/W9. Wave numbers are identifiers, not priority — W12 and W13 are new but both outrank the older unstarted waves.

W12 first for three reasons: demo mode is the mode whose entire purpose is being safe to show other people, and it currently fails hard on `/usage` (#443), leaks real project names on four routes (#441 + three), and leaks the real `devRoot` and home path through the unguarded shell; the capture-pipeline context is fresh from PR #446; and it is the only wave that makes the published screenshot set fully shareable.

> **The margin narrowed on 2026-08-14** (see the correction under W12 item 4). The original ranking rested on demo mode publishing burn rate, MCP topology and the real skill inventory — those turned out to be fixtures, so the exposure is `devRoot` + home path, not the inventory of a user's whole setup. W12 is still the recommendation on coherence, fresh context and the shareability criterion, but **W13 is now a defensible first move instead** — #425 is a silent wrong answer (a filtered search reporting zero matches that exist), and a confidently wrong result outranks a smaller leak on some readings. Worth an explicit call rather than inheriting this one.

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

> ### W1 REVERTED — 2026-08-12
>
> **Next.js was pinned back to `~16.2.12` in v1.10.1.** 16.3.0 miscompiles an `async` function in `src/lib/data/index.ts` so that a value the function provably returns arrives at its caller as `undefined`; `/api/usage`, `/api/stats`, `/api/skills` and `/api/sessions` returned 500 on every request. Bisected against a copy of a real 6,078-session index — last good `cea6509`, first bad `7d96242` (this wave's upgrade), parent and child — then isolated by changing *only* the Next version on the last-good commit. Details on #432, which stays **open**: the pin is a workaround, and a future `next` bump (including a routine Dependabot PR) re-breaks the same four routes.
>
> **So W1's headline win is undone**: #396's four postcss alerts are re-opened, and there is no fixed Next release to escape to (16.3.0 was still latest at the time of writing). #284 remains retired on its own evidence; #287's 9→4 improvement was tracer-version-dependent and should be re-measured if it matters.
>
> **How it shipped past the gates, which is the part worth keeping.** This wave's record says it was verified with "an out-of-repo smoke test of `dist/minder-server` (4 routes, all 200)". That gate ran, passed, and proved nothing: the failure needs a **large real index** *and* the **first request after a cold boot**. Against a fresh or small index every route returns 200, and a later request in the same process often succeeds even when the index is large — so a retry that goes green is not evidence either.
>
> **Gate for any future framework upgrade** (a documented step, deliberately not CI automation — CI has no 1.9 GB index): point a packaged build at a `VACUUM INTO` copy of a real index via `MINDER_STATE_DIR` and probe `/api/usage`, `/api/stats`, `/api/skills` and `/api/sessions` — **one cold boot per route, four boots total**, each route the first request its process ever serves. One boot followed by four sequential probes tests only the first route: by the time probe 2 fires the process is warm, which is the condition under which this bug goes green. `/api/agents` is a useful control — it was unaffected throughout, so run it as a fifth boot to confirm the harness itself works.

> ### W1 RESOLVED — 2026-08-18

> **The gate ran, and `next` is un-pinned to `~16.3.1`.** Three arms on one machine with only the framework version differing: **16.3.0 reproduced 4/4 failures** with the exact TypeErrors on #432, and **16.3.1 returned 200 on all five routes across two independent runs** — ten cold boots, zero TypeErrors, real payloads rather than 200-shaped errors. Index copy: 1.88 GB, 6,512 sessions, 210,942 turns. Full table and harness recipe on #432.
>
> **The negative-control arm is the finding to carry forward, not the verdict.** Running only the candidate version cannot distinguish "fixed" from "the harness cannot see the bug" — which is precisely how this wave's original upgrade passed its gate and shipped broken. Any future framework probe should reproduce the failure on the known-bad version *first*, and treat an all-green candidate run as uninterpretable until it does.
>
> **A third false-green trap surfaced while building the harness**, alongside the two already recorded above: **readiness cannot be detected by polling the server over HTTP**, because that poll is itself request #1 and warms the process before the probe fires. Detect readiness from the child's stdout instead. This is the easiest way to build a broken version of this gate, and it fails silently.
>
> **One correction to the recorded timing heuristic:** failing calls are *not* reliably faster than succeeding ones. It held on `/api/usage` (44s failing vs 96s succeeding) and inverted on `/api/stats` (54s failing vs 49s succeeding). Use the status code and the presence of the TypeError, not elapsed time.
>
> **Scope of the payoff, measured rather than assumed:** #396's **4 postcss alerts close**. The sharp alert does **not** — 16.3.1 moves Next's own sharp to 0.35.3, but the vulnerable 0.34.5 arrives via `@huggingface/transformers`, so the `next` pin never held it. #396's re-triage ("keep open until W1 lands") is now unblocked, against 4 rather than 5.
>
> **The gate itself is not retired.** The root cause was never identified, so "16.3.1 is clean" is an empirical result about one version, not a reason to trust the next one.

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

> **Residue as of 2026-08-14.** Six of the eight closed (#331, #345, #355, #362, #282, #175). **#273 and #220 are still open**, and two post-baseline issues join the same family: **#421** (tests delete inherited env vars without restoring them) and **#430** (`verify-windows` `isolatedState` teardown exceeds the 10s hook timeout removing a temp dir that still holds a SQLite handle). All four are cross-test interference, not product defects.
>
> **#421 is the enabler of the residue, on the same argument #331 was for the wave.** An unrestored env var is exactly the mechanism #331 was built to close — global state one test mutates and the next inherits — and both #273 and #220 are backend-selection divergences under full-suite load, which is what an unrestored `MINDER_*` var produces. Do #421 first and re-measure the other three before designing fixes for them; the wave's own record is that three of seven issues proposed timeout changes that measurement made unnecessary.

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
- **#395** — ✅ **Done** (see the closing note at the end of this entry). The two pre-design checks were run and both answers redirected the work.

  *Check 1 — how sidechain rows are keyed.* Neither option in the plan. **Zero** sessions mix root and sidechain turns; subagent transcripts are ingested as 1,260 **separate** sessions, and `parent_tool_use_id` is still NULL on all 188,181 rows, so there is no FK to walk. The linkage the issue calls a "sidechain-aware session tree" is nonetheless fully recoverable from `sessions.file_path` (`<project>/<parent-id>/subagents/agent-*.jsonl`): 1,260 children resolve to 126 parents, 126/126 present as indexed sessions. So #395 needs no schema change for linkage.

  *Check 2 — what `subagentCount` counts.* This is what stopped the wave. It reads `tool_uses['Agent']`, and `tool_uses` was missing **93%** of root-session spawns — 87 stored against 1,273 in the raw transcripts — because ingest dropped every tool block arriving on a repeat `message.id` line. Filed as **#426** and fixed first: a roll-up of `root + children` would have summed a 93%-short root against children that contribute nothing (sidechain rows carry no `tool_uses` at all, by design).

  *What the checks settled about #395 itself:* the gap is **real, not hypothetical** — scanning all 1,260 subagent transcripts raw found **62 nested spawns** and **191 nested web searches**. And the two caps have **opposite profiles**: for spawns #426 dominates (1,273 root vs 62 nested), but for web searches nesting is **4.5× the root total** (42 root vs 191 nested). #395 is the dominant cause for `webSearches` and a rounding error for `spawns` — which the issue, written before any of this was measured, had backwards. Remaining work for it is one ingest change (record `tool_uses` for sidechain turns) plus a roll-up keyed on the `file_path` linkage above.

  *How it was actually built, and where the plan above was wrong.* "Record `tool_uses` for sidechain turns" is the one line of that paragraph that did **not** survive contact. Writing subagent calls into `tool_uses` is safe only under a **corpus-local** invariant — the 0-of-6,045 no-mixing measurement — and that is a fact about this machine, not about the format: legacy Claude Code inlines subagent turns into the parent file, and on such a transcript the same write silently moves the parent's own `subagentCount` and `toolUsage`, which #395 explicitly forbids. It would also have required an `is_sidechain = 0` predicate in ~20 queries behind `/usage`, `/agents`, `/skills`, `/costs` and the denial analytics, where one missed site is a silently moved number and no test fails. So the calls went into their own table, `sidechain_tool_uses`, and `tool_uses` was left untouched.

  Two other decisions worth recording. Storing **observed tool names** rather than resolved `spawns`/`web_searches` columns keeps the interpretation at read time — deciding later that `WebFetch` counts toward the search cap is then a query edit rather than another `DERIVED_VERSION` bump and an hour-long re-parse. And the bump to **20 is load-bearing rather than bookkeeping**: the roll-up refuses to report a total unless the root and every child are stamped at 20, so a not-yet-re-derived index reports *unmeasured* instead of silently returning the root-only count — which would have been the original bug wearing the new field's name. Gate is `>=`, never `===`, per the v14 incident in `derivationVersion.ts`.

  *What the review round changed, and it was the design's weak point.* The first cut stored `sessions.parent_session_id` at ingest. Codex spotted that this **inverts the completeness gate**: a stored link is written by the same parse that stamps `derived_version`, so a child that has not been re-derived carries no link at all — it never enters the children list, the gate finds nothing stale to reject, and the root's own counts are returned as a complete tree. The gate protected against the case that cannot happen (linked-but-stale) and missed the one an upgrade produces on every session (stale-therefore-unlinked). Linkage is now derived from `file_path`, which is present on every row at every version, and the column is gone. Codex also caught that a per-tool **counter** has to be written additively (the tail path amends rather than replaces) and so doubles a tool block re-logged across a window boundary, permanently; rows keyed on `tool_use_id` make the write idempotent instead. Copilot caught a locally-invented session-id regex stricter than the app's own `isValidSessionId`, where the error is asymmetric — a rejected id silently drops a whole branch. All three were real, and all three were the same failure to ask *what does this look like mid-upgrade, rather than after one*.

  Final tallies from the probes: 1,260 subagent transcripts, 37,394 `tool_use` blocks over **37,311 distinct ids** (so the same one-line-per-block dedupe #426 needed applies here too), `Agent` 62 and `WebSearch` 123 nested. The earlier "191 nested web searches" figure was `WebSearch` + `WebFetch` summed; only `WebSearch` counts toward the cap, so the number that matters is 123 against 42 at root — still ~75% of all searches invisible before this.

- **#426 — tool-call indexing** ✅ **Done, unplanned.** Found by the #395 pre-design probes and fixed in its own PR. Claude Code writes one JSONL line per content block; ingest's re-log guard `continue`d on the repeat `message.id` and discarded the block. 2,716 tool blocks in one file against 720 stored, `Agent` 72 → 6, and **5,652 of 6,036 sessions holding no `tool_uses` rows at all**. Text was lost the same way — a message whose first block was `thinking` stored no prose — which reaches `text_preview`, the FTS body, and the classifier's `assistantText`. `DERIVED_VERSION` 18 → 19.

  *The lesson worth keeping:* the plan, the issue, and the code comments all described the symptom's cause as nesting, and all three were wrong in the same direction. What separated them from the truth was reading the **raw transcripts** rather than the index — the index cannot report what it failed to store, so every query against it confirmed the wrong story. A zero from a system is not evidence of absence until you have checked that the system can represent a non-zero.

**The segmentation numbers, re-measured** (the plan's figures were from 2026-08-05 and the corpus has grown): interactive `cli` costs **$13.43**/session against `sdk-cli`'s **$0.22** — the gap widened from 44× to **61×** — and the inversion sharpened: **69%** of 6,024 sessions are SDK-driven and account for **4%** of the spend. Direction held across both measurements, which is what matters; the multiple on any one day does not. Sourced from the index, per this wave's own standing caveat about file probes.

**Guard rail: 5 mutations run, 1 survived and became a test.** `queryByCategory` has two SQL bodies and only the `category_costs` rollup one was covered — the source/home-filtered body could drop the rate entirely with the suite green. Caught by mutation, pinned by a `?source=` read. *A function with two implementations of the same contract needs a test per branch, not per function.*

---

## Wave 6 — Accessibility (#391)

Follow-up to #380/#390. The `.sr-only` + `aria-hidden` pattern reached screen readers but **not** sighted keyboard users (`.sr-only` is visually clipped; `title` doesn't appear on focus in any major browser) or touch users (no hover, nothing to tap). The remedy is a shared tooltip primitive that opens on hover **and** focus **and** tap, then migrating the load-bearing `title=` usages onto it. Medium: one primitive, then a mechanical sweep.

---

## Wave 7 — Service mode + build hygiene

*Grew from 2 issues to 6 on 2026-08-14: W1 is void, so its two surviving build-tracing issues moved here, and two post-baseline issues joined them. This is now the single place build hygiene lives.*

- **#413 — packaged standalone serves nothing when `MINDER_USE_DB=0`, not even static assets.** Take this **first**: it is the only one of the six that is a user-facing outage rather than DX, and `MINDER_USE_DB=0` is the documented escape hatch for exactly the situation where the DB is the problem — so it fails when it is most needed. Found during W1, never scheduled until now.
- **#295 — `tauri-build` `rerun-if-changed` over `dist/minder-server` makes `cargo build`/`clippy` ~2 min.** Narrow the watched path set. Pure DX, but it taxes every Tauri iteration.
- **#296 — `MINDER_BOOTSTRAP=0` shutdown runs ~0 disposers.** Ingest and the dispatcher still start, but disposers are only registered by `runBootstrap`, so the "don't bootstrap" mode leaks. Register disposers independently of the bootstrap flag.
- **#417 — derive the tracing/hygiene exclusion lists from `.gitignore` instead of maintaining them by hand.** W1 is the argument for this: the list *grew* three times in one wave (`.env.local`, `.mcp.json`, `agentlytics-repo/`), each time after something git-ignored had already been traced into `.next/standalone` and was caught only by `package-standalone`'s prune on the way out. A hand-maintained list is discovered to be incomplete by shipping.
- **#287 — Next's own `.next/standalone` tracer omits nested deps under `node_modules/next/node_modules/`.** W1 shrank it 9 → 4 missing deps, but that improvement was tracer-version-dependent and the pin back to 16.2.12 may have undone it. **Re-measure before fixing** — the backfill in `scripts/package-standalone.mjs` is still load-bearing either way.
- **#284 — what flips a route into NFT's whole-project sweep.** Retired as a wave-scale item on its own evidence (bimodal, 124 routes vs 89, three hypotheses falsified); it survives as a `TODO.md` item with one named next experiment — the 2 swept routes carrying no native addon (`/api/claude-config/user`, `/api/mcp-health`) are the smallest instances. Do the experiment only if a W7 branch is already in the tracer.

**Ordering note.** Three of these are tracer-shaped and share one slow verification loop (`pnpm build` + `package:standalone` + an out-of-repo smoke test): **#417, #287, #284**. Batch those rather than paying the loop three times.

The other three each verify differently and should **not** inherit that loop:

- **#413** — a correctness fix; verify by serving the packaged build with `MINDER_USE_DB=0` and requesting a static asset.
- **#295** — build-time DX; verify by timing `cargo build`/`clippy` before and after.
- **#296** — a **runtime lifecycle** defect, not a build one. *(Codex, PR #447.)* An earlier draft of this note lumped it in with "the other five are all tracer/build-shaped", which is wrong: the fix touches `instrumentation-node.ts`/`bootstrap.ts`, and it needs an assertion that the disposers actually run at shutdown under `MINDER_BOOTSTRAP=0`. `pnpm build`, `package:standalone` and a route smoke test all pass while the leak is fully intact — the packaging loop cannot see this defect at all, which is precisely the "gate that proves nothing" shape this repo has been bitten by before.

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

## Wave 10 — Cloud session ingest — ✅ **CLOSED AS MOOT (2026-08-15)**

> ### W10 outcome — the spike ran, and the answer was no
>
> **The endpoints do not exist.** `GET https://api.anthropic.com/v1/sessions` returns **HTTP 404 `not_found_error`** with a valid, unexpired OAuth token and the `x-organization-uuid` header. `/api/sessions` was probed as a variant and 404s identically.
>
> **The control is what makes this conclusive**, and it is the reason the spike is worth more than the upstream report. Four probes ran in the same process with the same headers — the target, a known-good route, an invented path, and a URL variant:
>
> | Probe | Result |
> |---|---|
> | `/v1/models` (control — known-good route) | **HTTP 200** |
> | `/v1/definitely_not_real` (control — path invented for this run) | HTTP 404 `not_found_error` |
> | `/v1/sessions` (target) | HTTP 404 `not_found_error` |
> | `/api/sessions` (target — URL variant) | HTTP 404 `not_found_error` |
>
> So the target is **indistinguishable from a path that was made up**, while the credentials demonstrably authenticate against the same host. This is a missing route — not an expired token, not a wrong header, not a network failure. Confirms [simonw/claude-code-transcripts#77](https://github.com/simonw/claude-code-transcripts/issues/77) **against our own account** rather than on trust.
>
> Without the control the 404 would have been ambiguous, and the plan's standing caveat about unverified causal claims says a bare 404 should not have been read as "the endpoint is gone". This is the repo's own lesson applied forward: *a zero from a system is not evidence of absence until you have checked the system can represent a non-zero.*
>
> **What closes:** all 5 TODO items, archived to `TODO.archive.md`. The **distribution-risk decision** — personal-only vs. shipped to other installs, deliberately deferred since W0 on 2026-08-08 pending exactly this result — is now permanently unnecessary. That deferral was correct: answering it in W0 would have been an hour spent designing consent strings, retention policy and a feature flag for a feature that cannot exist.
>
> **What does not close:** the driver. Sessions run on claude.ai/code still produce no local JSONL, so they remain invisible to every Minder read surface, and `ProjectDetail.tsx:170`'s `prSessionLinks` still dangles for any PR opened from a web session. There is no longer a route to fixing it from this direction. If a supported API appears, reopen the archived section — the design work is done and should not be re-derived.
>
> **The spike script is deliberately not committed** — it reads `~/.claude/.credentials.json`, and `src/lib/adapters/types.ts` states that auth/credential files are never read. Shipping it would contradict that invariant for a script the repo never runs. It is preserved in the archiving PR; re-testing is a few minutes' work from the description above, and the control probe is the part not to skip.

*Original plan below, retained as the design record.*

## Wave 10 — Cloud session ingest (gated on the W1 spike) — superseded

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

## Wave 12 — Demo-mode coverage (new, 2026-08-14) — **recommended next**

**Driver:** the route-by-route audit on 2026-08-12 measured what `MINDER_DEMO=1` actually covers and found it is about half of what the flag's description implies. Demo mode exists for first-run, screenshots and demos — a screen that renders empty or leaks real data there fails in precisely the situation it was built for. Three issues (#441, #443, #445) plus the six `TODO.md` findings — five from the 2026-08-12 audit and the `/stats` cross-check leak added 2026-08-14 during this plan's review.

**Recommended order — worst failure first:**

1. **#443 — `/usage` throws "circular link" under demo mode** and renders the browser error page instead of the app. The only demo-mode failure that is hard rather than leaky, so it is also the easiest to verify fixed.
2. **#441 + `/adapters`, `/config`, `/plans`** — one family, one fix pattern. Only 19 of 165 API routes reference `demoMode` at all; most are covered transitively through the `data/index.ts` façade and these four are not. **Worth an audit rather than four patches**: establish which routes are covered by the façade and which need their own guard, then close the set. Four known instances found by one audit is weak evidence that there are exactly four.
3. **`/stats` cross-check reads the real Claude stats cache under demo mode** — *added 2026-08-14 by Codex on this PR; it was in neither the audit nor `TODO.md`.* `buildStatsResponse` (`src/lib/server/queries/stats.ts:88-118`) calls `getStatsCache()` unconditionally, which reads `~/.claude/stats-cache.json` (`scanner/claudeStats.ts:26`) with no demo guard, so the cross-check panel compares demo totals against the user's **real** session and message counts. `capture-screenshots-hybrid.mjs:70-72` already documents the visible symptom — a red "-91% / -100%" drift — and refuses to promote that frame.

   **This one is load-bearing for the wave's exit criterion**, not another entry on the pile: `stats-dashboard` is in the capture set (`capture-screenshots.mjs:426-429`), so every other item here could be closed and a single demo pass would still publish real totals. Worth noting the leak was *already known to the tooling* and recorded only as a capture-script comment — the hybrid script's refusal to promote the frame was the system telling us, and nobody had written it down where the plan would see it.
4. **`RootLayout` leaks `devRoot` on every route** (`TODO.md`). `src/app/layout.tsx:43-48` calls `readConfig()` → `getDevRoots(config)` inline in a server component, so it never passes through the façade or any route where a guard could apply; `/hooks` has the same shape and prints the real home path. Fix at the shell — per-route is how the gap happened.

   > **Scope corrected 2026-08-14 by Codex on this plan's own PR (#447).** This item was written as *"the app shell is never demo-guarded, so every screen leaks real data"* and ranked **first** in the wave on that basis, citing the burn percentage + 7-day cap, MCP health, and the Quick Launch skill slugs alongside `devRoot`. Those three are **fixtures**, and their routes are correctly guarded: `demoQuota()` returns `"7d": { utilization: 0.52 }` — the literal "52%" the audit reported as a real burn rate (`demo/activity.ts:298`); `demoMcpHealth()` deliberately seeds one `status: "down"` server (`:207`); `demoSkills()` contains `changelog` / `gsd-planning` / `pr-review` / `memory` by name (`demo/catalogs.ts:273-325`).
   >
   > The mechanism claim survived and the impact claim did not — roughly 4:1 — which is why this dropped from rank 1 to rank 4. **The audit method is what to fix, not just the entry:** a value was recorded as exposure because it looked like the user's real data, when looking like real data is precisely what a good fixture does. A suspected leak has to be checked against the fixture that could have produced it before it counts. Note this is the *inverse* of the standing lesson from #426 — there, a zero was not evidence of absence until the system was shown able to represent a non-zero; here, a plausible value was not evidence of a leak until the fixture was shown unable to produce it.
5. **~18 empty screens** (`TODO.md`) — the long tail, and the reason `capture-screenshots-hybrid.mjs` needs two passes at all. Fixtures here would let the whole capture run on demo data and make the published screenshot set fully shareable. Scope it by what the capture set actually uses.
6. **#445 — standardize on one loading idiom.** *Demoted from rank 1 on 2026-08-14 — see the correction below.* Real maintenance value (three idioms, and the detector that covers them is a hand-maintained list that must track all of them — the same shape as #417's hand-maintained exclude list), but **not** a prerequisite for anything else in this wave.

   > **Corrected by Codex on this plan's own PR (#447), second finding of the same round.** This was ranked first and labelled *the enabler*, on the claim that the wave's core measurement — does a screen render fixtures or nothing — was impossible without it because *empty* and *still loading* are externally indistinguishable. **That was already false when written.** `waitForStableUI` in `scripts/capture-screenshots.mjs:220-254` (shipped in PR #446, merged the same morning) detects all four idioms — `.animate-pulse`, "Loading…"/"Connecting…" text, bespoke placeholders via `[style*="pulse"]` with a ≥24px height floor, and Next's Compiling pill — plus a body-text-length stability check, and returns false so `shoot()` skips the capture and records a failure. The measurement works today. Blocking the wave on this would have delayed a hard failure and two verified leaks behind a maintenance task.
   >
   > **Twice in one PR the same way** (see item 3): a claim about demo-mode/capture behaviour was written from what the situation looked like rather than from the code, and both times the source said otherwise. The pattern is asserting a *capability gap* — "you can't tell X from Y", "that value must be real" — without opening the thing that would already close it. For this wave specifically, check `capture-screenshots.mjs` and `src/lib/demo/` before claiming either.
7. **`/analytics` never finishes loading** (90s hard timeout, the audit's only one) — **cause unknown; do not inherit a hypothesis.** `src/app/analytics/page.tsx` renders a static `ComingSoon` component: no data fetching, no endpoints, nothing that can take 90 seconds on its own. So whatever the audit hit is *not* in this page, and the first step is to reproduce it in isolation — one navigation, no capture run in flight — before attributing anything. Most likely candidates are capture-run or global server contention, or a measurement artifact of the audit harness itself.

   > *Corrected 2026-08-14 (Codex, round 4).* This read "likely the same session-JSONL parsing cost as #439, so check W13 first". `/analytics` never calls the Hot Files or File Coupling endpoints #439 covers — fixing #439 cannot make this page finish loading, so the dependency would have sent the investigation into the wrong subsystem. **The symptom is real; the explanation was invented.**
8. **Home's `0 projects · 0 active sessions` header** (`TODO.md`) — *not demo-specific*, and the one item here that may not belong: it reproduces on real data too. First establish whether it is simply awaiting the ~130s `/api/projects` scan or is wired to a source that never resolves. If it is the scan, it is a perf item and belongs in W13.

**Exit criterion:** a full capture run under `MINDER_DEMO=1` alone produces a publishable screenshot set — no second pass, no real data in any frame, no blank screens. That is a single testable claim, unlike "demo mode is better".

---

## Wave 13 — Index-backed reads & aggregation correctness (new, 2026-08-14)

**The unifying defect:** in all three, the SQLite index can answer the question correctly and the read layer either does not ask it or asks it too late. Same shape as #426 and the W5 `byCategory` finding — and the same standing lesson, that a zero from a system is not evidence of absence until you have checked the system can represent a non-zero.

- **#439 — Hot Files / File Coupling take 30–100 s** because the routes parse all session JSONL instead of using the index. Largest win of the three. *(An earlier draft added "and it may also close `/analytics` in W12" — removed 2026-08-14: `/analytics` is a static `ComingSoon` page that never calls these endpoints. See W12 item 7.)*
- **#425 — session facets are applied after the FTS top-200 cut**, so a filtered search can confidently report zero matches that exist. *The worst failure mode in this wave*: it is silent and it looks like a correct answer. Push the facet predicate into the query, before the cut.
- **#416 — `byProject` splits a macOS project recorded under two path casings** (case-insensitive APFS). The wave's quick win; the case-folding pattern already exists in the scanner from #249–257.

**Gate:** each of these changes a number the UI already displays, so verify by probing the index directly before and after — not by whether the page still renders. W5's mutation-testing lesson applies squarely: a function with two implementations of the same contract needs a test per branch.

---

## Housekeeping (ride-alongs, no dedicated wave)

- **Capture `worktrees.png`.** Mechanism shipped 2026-06-29 — `capture-screenshots.mjs` step 15 self-discovers a project with an active worktree overlay and skips cleanly when none exists. **Needs a live worktree:** with an active `*--claude-worktrees-*` present, run `pnpm capture:docs`, then point `site/index.html` (~line 105) at the new file. It currently honestly shows `todos-tab.png`. **Do this during any wave that creates a worktree** — most of them will.
- ~~**PR check warning on screenshot-without-prose changes.**~~ ✅ **Shipped** as `.github/workflows/site-screenshots-check.yml`; archived 2026-08-12. Deliberately one-directional (prose-only changes pass) and deliberately not a required status check.
- **The `DERIVED_VERSION` release gate, the #432 cold-boot gate, and the cloud spike** are recorded in the Status reconciliation above as standing items. They are not ride-alongs — they condition other work and two of them will silently go green while broken if run the obvious way.

---

## Recommended first move

> ### Superseded 2026-08-14 — the original recommendation is below, kept as the record
>
> **Wave 12 (demo-mode coverage), starting with #445.**
>
> W12 is the open cluster closest to a data-exposure defect rather than DX or latency: demo mode is the mode whose entire purpose is being safe to show other people, and it currently fails hard on `/usage`, leaks real project names on four routes, and leaks the real `devRoot` and home path through an unguarded shell. The capture-pipeline context is fresh from PR #446, and the wave has a single testable exit criterion — one `MINDER_DEMO=1` pass produces a publishable screenshot set. *(Margin narrowed 2026-08-14: three of the claimed leaks were fixtures. See the correction under W12 item 4 — W13 is a defensible alternative first move.)*
>
> Start with **#443** — the hard failure — then the leak family. *(#445 was originally named as the starting enabler; corrected 2026-08-14 — the capture pipeline already detects all four loading idioms, so it is maintenance, not a prerequisite. See W12 item 6.)*
>
> **Runnable in parallel:** W13 (index-backed reads) touches `src/lib/data` and the FTS query layer; W7's #413 touches the standalone packaging path. Neither collides with W12's shell/fixture work.
>
> **Needs you, not a wave:** the cloud spike — blocked by the permission classifier since W1, script written, and the cheapest question in the backlog since a dead endpoint deletes five TODO items outright.

**Original (2026-08-08):** Wave 0 (decisions) + Wave 1 (Next 16.3) + the cloud spike, in that order within a single session. Wave 0 is conversation, not code — it costs one pass and removes 8 issues from the count. Wave 1 is a single focused branch whose verification steps are already written down. The spike runs in the background of Wave 1's slow build and tells us whether an entire backlog section is even real. Wave 2 (quick wins) can run as a parallel branch — it touches none of the same files.

**Standing gates for every wave:** `pnpm typecheck` → full test suite → `pnpm build` when `src/` is touched. Never pipe a gate's output through a filter; redirect to a file and check `$?`. Only one `pnpm build` at a time.
