# Insights

<!-- insight:30b3498264a7 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T21:51:48.981Z -->
## ★ Insight
The `[ingest-worker] started; entry=...` line in production confirms three things at once: (1) the instrumentation hook's env-flag dispatch chose the worker path; (2) `process.cwd()` resolves to the project root under `next start` (so the worker entry path is correct); (3) `startWorker()`'s `await readyPromise` resolved — the worker emitted `ready` and the host registered it. The HTTP 200 from `/api/projects` while the worker is alive proves the main thread's HTTP server isn't blocked by worker spawn.

---

<!-- insight:ba8ef1369fe0 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T21:41:18.441Z -->
## ★ Insight
The advisor's framing is sharp: "lifecycle is where the bugs are." With Next.js + Turbopack + Node `worker_threads`, the bundling layer is the trap — Turbopack will try to bundle anything under `src/` or `app/`, but a root-level `workers/` directory escapes its scope entirely. Using `process.cwd()` at runtime sidesteps the dev-vs-`.next/` path divergence too, which would otherwise need awkward `import.meta.url` shims.

---

<!-- insight:b2ebe4b50db2 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T21:15:47.569Z -->
## ★ Insight
- The byte_offset bug is the kind that only surfaces when a JSONL writer is mid-flush — a race window of milliseconds. But Project Minder's whole design is to react in real time to those flushes, so we'll hit it. The fix is to track the position *after the last consumed `\n`* and never advance past a partial line. Same code path applies to both full and tail reads, so the fix is one helper.
- The truncated-JSON bug is the classic "two-step downgrade" failure: we truncate (lossy), then we parse (strict), and there's no recovery in between. Fixing the truncation alone (bump limit) is a partial fix; adding a best-effort `command` recovery on rehydration is the belt-and-braces.

---

<!-- insight:23dafdd29fdf | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T21:02:53.089Z -->
## ★ Insight
- Lesson for the future: `git stash pop` returning "stash entry is kept" is the silent-failure mode that bit us. When you see that message, run `git status` and `git stash show stash@{0}` immediately — anything that didn't actually re-land is sitting in the stash, not in the working tree, and a subsequent `git stash drop` would delete it forever. Better practice on dirty-tree commits is `git commit -- specific.files` rather than stash-and-pop, since the file-level commit avoids the round-trip entirely.
- All 12 source repos were valuable but a few stand out: Clauditor (multiple variants), `build-your-own-dashboard-prompt.md` (the embedded brainstorming doc), and the Anthropic OTEL telemetry feature are the highest-leverage. The Mission Control section in particular reframes Project Minder from observer → controller — that's a strategic direction shift worth flagging to you, not just a backlog dump.

---

<!-- insight:01ab4161e407 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T20:45:34.216Z -->
## ★ Insight
- The biggest of these is the `toolResultText` rehydration gap. `detectOneShot` reads `turn.toolResultText` to find error patterns ("FAIL", "Error:", etc.) in tool result content. When we rehydrate user turns from `text_preview` only, we lose that text. Result: a previously-failed verification turn looks like "no error" after tail-append, and `has_one_shot` flips to true incorrectly. This is exactly the kind of subtle parity bug that ships unnoticed until someone's stats look wrong.
- The fix needs a schema migration: add a `tool_result_preview` column to `turns` so the tool-result content survives the round-trip. Fresh DBs get it via `schema.sql`; existing DBs get it via migration v2. Bumping `DERIVED_VERSION` to 2 forces a one-time full re-parse of all sessions so the column is populated before any tail-append depends on it.

---

<!-- insight:6d9a7410c888 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T20:01:20.495Z -->
## ★ Insight
- The advisor's call on `byte_offset = position-after-last-newline` is the kind of invariant that's worth documenting in code: it's invisible until something breaks. P2a-2.1 wrote `file.size` and got away with it because Claude Code's JSONL writer always terminates with `\n`. Document the dependency explicitly so a future writer that drops the trailing newline doesn't silently corrupt our cursor.
- `detectOneShot` is the subtle constraint here. It looks at sliding windows of turns — Edit→Bash(test)→re-edit. A turn appended in the tail can change the verdict on prior turns. So we can't just run detection on the new tail in isolation; we have to re-run over old+new, which means rehydrating UsageTurn[] from existing DB rows. That's a new helper.

---

<!-- insight:f08d96e4485a | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T18:57:12.336Z -->
## ★ Insight
- The reuse review surfaced a latent bug: I'd written `extractAgentName` to match `tool_name === "Task"` based on the Anthropic API SDK convention, but the existing parsers (`agentParser.ts`, `classifier.ts`) all match `"Agent"` because that's what Claude Code's internal protocol actually emits. Verified by sampling ~10 real JSONL sessions in this user's `~/.claude/projects/`. This is exactly why "reuse existing" beats "rewrite parallel" — the existing code already had the right convention baked in.
- The three agents converged on cost-formula triplication and tool-name string-literal duplication. Both are clean-up wins.

---

<!-- insight:9d33163e1793 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T18:00:49.966Z -->
## ★ Insight
- 15 comments total. Some already addressed by /simplify (closeDb→available reset, isDbAvailable derivation, turns_au guard). Several are real correctness issues — the getDb race, "quarantine when driver missing," and "meta exists but schema_version missing" are all bugs latent in the current code.
- The FTS UNINDEXED-column delete concern (Copilot #8) is real but the suggested fix is a structural redesign with a mapping table; better to acknowledge with a TODO and defer to P2a-2 when ingest data lets us measure rather than speculate.

---

<!-- insight:fc163b3ece24 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T17:53:12.395Z -->
## ★ Insight
- Two of the React/Next.js idioms collide here: "wrap entire card in `<Link>` for cardwide navigation" + "interactive sub-action inside card." Browsers can't represent that — `<a>` inside `<a>` has no defined semantic. Different codebases solve this differently; the most common patterns are (a) make the card a `<div>` with an onClick + an inner `<Link>` for the primary destination, or (b) keep the outer `<Link>` and make sub-actions buttons that programmatically navigate.
- We're picking (b) because the card already has a richer set of interactive descendants (DevServerControl, PortEditor, DropdownMenu) all using preventDefault/stopPropagation — adding one more is consistent. The trade-off: the CI badge loses real link semantics (no middle-click "open in new tab"), but it stays consistent with the card's existing internal-action vocabulary.

---

<!-- insight:9446a2841c4f | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T17:42:37.819Z -->
## ★ Insight
- The three agents converged on a real issue I missed: `derived_version` vs `category_version` are the same concept under two names. That kind of subtle naming drift is exactly what causes future bugs in the re-derive loop because the indexer has to remember which column matters per table.
- The TOCTOU pre-check (`fs.access` before `fs.rename`) was independently flagged by both reuse and efficiency reviewers — when two unrelated lenses converge on the same line, that's a strong signal.

---

<!-- insight:05095771be56 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T15:13:13.778Z -->
## ★ Insight
- 14 files / 747 insertions / 330 deletions for one phase. The deletion count is meaningful — when polling consolidation is done right, you remove more code than you add (the AppNav timers and NotificationListener interval went away entirely). Net additions of 417 lines is mostly `<PulseProvider>` + `liveStatus.ts` + the virtualized SessionsBrowser scaffolding.
- This PR closed three independent timer loops, an Audio leak, and an O(n²) breakdown re-render — but didn't touch any of the data-layer work the plan calls out as the **biggest** wins (cold parse times, RSS pressure, LCP). Those need P1 (mtime cache) and P2 (SQLite). Easy to forget that "client quick wins" are a real but bounded category.
- The two fix-up commits (one on this PR, one on #33) added a useful pattern for the remaining phases: keep the initial commit narrow, let the bots find real bugs, batch-resolve threads after the fix lands. Faster than addressing comments inline during initial development.

---

<!-- insight:d3f50f607c7f | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T15:12:02.262Z -->
## ★ Insight
- The cursor-advance bug (#2) is a classic distributed-systems pattern: when client and server agree on a "high water mark", advancing the watermark optimistically (before confirmation) gives at-most-once delivery; advancing only after confirmation gives at-least-once. For change events feeding toasts and notifications, at-least-once is usually correct — duplicate toasts are mildly annoying; missed events are silently broken.
- The `liveStatus` TTL/poll interval mismatch (#3) is the kind of bug that's invisible in code review but obvious in retrospect: if `cache_ttl < poll_interval`, the cache is functionally inert. A useful invariant to audit any time you couple a cache layer to a polling cadence.
- The `pendingSteps: 0` regression (#1) was a deliberate design choice ("don't block the 5s pulse on a 2.7s scan") that turned out to be wrong because the watcher invalidates the cache exactly when changes happen — the worst-case timing. The right fix used a separate, cheaper data path (the watcher's own file reads) rather than rethinking the original trade-off.

---

<!-- insight:e7bddb91ae88 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T14:50:48.071Z -->
## ★ Insight
- The `next.config.ts` change turned out to be a no-op (Next 16 already auto-optimizes lucide). I left it in defensively — it makes the *intent* explicit in code even if it doesn't move bytes. Useful baseline if a future Next version changes its default optimization list.
- The `/api/pulse` design has one nuance worth noting: it deliberately **does not trigger** a project scan. If we did, every 5 s pulse would risk blocking on a 2.7 s `scanAllProjects()` call when the cache is cold. Instead we read from the existing scan cache, returning `pendingSteps: 0` when it's cold. That's accurate (the dashboard hasn't told us yet) and self-corrects within seconds once the user navigates anywhere that warms the cache.
- `useInView` paired with `React.memo` + `useMemo` gives compounding wins: parse work only happens for items in/near viewport, AND when those items do mount, parse runs once. Without the memo, scrolling past an item and back would re-parse it on every cycle.

---

<!-- insight:1ee78e5d3f62 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T14:42:03.045Z -->
## ★ Insight
- Virtualization with grouped data is most cleanly done by **flattening** the tree into a single positional array of items where each item is tagged with its kind. The virtualizer doesn't need to know about groups — it just renders item N at position N. Group/section semantics live in the source array, not in the rendering layer.
- `useVirtualizer.measureElement` reports actual rendered height back to the virtualizer so dynamic heights work without manual measurement. The trade-off is one extra DOM measurement per render — negligible compared to mounting 1,000+ items at once.

---

<!-- insight:f084fd450b8f | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T14:35:21.713Z -->
## ★ Insight
- `React.memo` on `RenderedContent` skips re-rendering when the parent re-renders but `text` is unchanged. Combined with `useMemo` on the actual `parseMarkdown` call, the work happens once per unique text value rather than once per parent render.
- An `IntersectionObserver` with `rootMargin: '500px'` starts mounting content half a viewport before it scrolls into view — by the time the user reaches it, parsing is already done. We only observe until the item becomes visible once, then disconnect — a one-shot pattern that avoids keeping observers alive forever.

---

<!-- insight:32e3a65b3075 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T14:33:02.717Z -->
## ★ Insight
- Next.js 16's `optimizePackageImports` includes a built-in list of known-good libraries (lucide-react, date-fns, @mui/icons-material, recharts, etc.) that get auto-optimized without any config. Setting them explicitly is a no-op for them, but useful as defensive documentation.
- The 222 KB largest shared chunk is likely React + Next.js runtime, not icons. To drop it materially, you need RSC (less client code shipped) or to swap heavy deps — neither is in P0 scope.

---

<!-- insight:8da4372f5175 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T14:31:21.066Z -->
## ★ Insight
- A `new Audio(...)` is a heavyweight Web API object: it allocates a media element, registers itself with the document's media session, and holds a network handle to the source URL. Allocating one per notification means every alert leaks resources until GC. A module-level singleton means we allocate one element for the lifetime of the page.
- Calling `audio.currentTime = 0` before `audio.play()` is the standard way to "rewind and replay" the same element when notifications fire in quick succession.

---

<!-- insight:7fd9572aecac | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T14:30:17.208Z -->
## ★ Insight
- The repo uses GitHub's newer **Rulesets** rather than the legacy branch protection (the `branches/main/protection` API returned 404 even though merging was clearly blocked). Inspect rulesets via `repos/{owner}/{repo}/rules/branches/main` — that's where `required_review_thread_resolution: true` and the `verify` status check are defined.
- `required_review_thread_resolution` is a useful guardrail but it counts every bot comment as a thread that has to be resolved, even when the bots are repeating themselves. Batch-resolving via the GraphQL `resolveReviewThread` mutation is far cleaner than clicking through the UI — particularly when you've addressed the underlying issue in a follow-up commit and just need the threads marked resolved.
- The 9 line comments collapsed into 4 unique issues, but the threads-to-resolve count is still 10 — duplicates count as separate threads. Worth knowing for future PRs that attract noisy bot reviewers.

---

<!-- insight:a4acf12fa5d2 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T14:19:48.080Z -->
## ★ Insight
- The pre-commit hook (typecheck + tests) saved the commit from going out broken — but only after I cleaned `.next/dev/types/` of the half-written files left behind when I killed the dev server abruptly. Future-me note: when killing a Next.js dev server mid-flight, those auto-generated `routes.d.ts` / `validator.ts` files can be left malformed and blow up the next typecheck.
- The PR is intentionally narrow: 5 files, 302 insertions, no app-code changes. That's the right shape for a baseline PR — reviewers see exactly what's measured, nothing else moves. Future phase PRs should each be similarly scoped (P0 in its own PR, P1 in its own, etc.) so we can roll back any phase independently.
- The 7 "uncommitted changes" warning is the user's own pre-existing work (modified `INSIGHTS.md`/`TODO.md`, untracked `PRODUCT.md`/`agentlytics-repo`/`capture-new.mjs`/`docs/brainstorming`/`screenshots`). I deliberately left those alone — they're not part of this PR's story.

---

<!-- insight:d2b47fe283f5 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T14:09:58.816Z -->
## ★ Insight
- The dev server's in-memory `parseAllSessions` cache holds a `Map<sessionId, UsageTurn[]>` for all 3,211 sessions. After warming, that's why warm-cache responses are 14–34 ms — the array of turns is sitting in V8 RAM. The flip side is the 1.5 GB RSS we measured. P2's SQLite indexer trades that RAM for a memory-bounded query engine.
- `/sessions` CLS of 0.53 is the smoking gun for poor visual stability — every time data lands and a row gets added to the un-virtualized list, the page reflows. P0 virtualization plus a fixed-height skeleton during loading should drop this below 0.1.
- Lucide-react being 44 MB on disk doesn't directly translate to bundle size (the tree-shake decides what ships), but the 222 KB largest shared chunk likely contains the icons that 45 files barrel-import. After `modularizeImports` we'll see that chunk shrink — that's the cleanest before/after measurement.

---

<!-- insight:37cdf3ddc714 | session:2e73f20b-ffd4-4b83-b03a-4919799ed2ad | 2026-04-30T13:55:31.881Z -->
## ★ Insight
- The plan deliberately introduces the mtime primitive (`FileCache<T>`) in P1 *before* the SQLite indexer in P2 — that primitive becomes the indexer's sync trigger, so P1 isn't throwaway work, it's the seam P2 plugs into.
- All four phases are designed so each one ships independently and improves the app on its own. The SQLite work in P2 is a foundation, not a prerequisite — but P3 (RSC + Server Components fetching directly) only makes sense once server queries are sub-100ms, which only P2 achieves.
- The schema in P2 is shaped not just for current pain but for the heaviest 30 backlog items (file-coupling arc diagrams, MCP rug-pull detection, OTEL ingest, FTS5 search). The "what this unlocks" table in the plan is the core argument for doing P2 now rather than papering over with more in-memory caches.

---

<!-- insight:7e6d506a3290 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-29T14:47:26.463Z -->
## ★ Insight
The popover overflow is a classic CSS layout problem: `position: absolute` popovers anchored to their trigger button always clip at the viewport edge when the trigger is near the right side. A production fix uses a `getBoundingClientRect()` check on mount to flip the `left`/`right` anchor — or a library like Floating UI. Worth a future TODO.

---

<!-- insight:b29c349c6890 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-29T14:39:36.457Z -->
## ★ Insight
Keep a Changelog's rule of one category heading per version is subtle — the format looks valid even with duplicates since markdown doesn't enforce uniqueness. The issue only becomes apparent when generating release notes programmatically or trying to scan the file visually. Keeping entries merged is both the spec-compliant and human-readable choice.

---

<!-- insight:b9fdd304fe44 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-29T14:31:05.857Z -->
## ★ Insight
The `h.projectSlug ?` ternary was a silent guard that hid the button entirely for user-scope items. Replacing it with an explicit `else if h.source === "user"` branch makes the intent visible — project-scope items get `excludeTargetSlugs` to prevent applying to their own source; user-scope items have no such restriction.

---

<!-- insight:cf69a8fc683a | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-29T14:29:19.030Z -->
## ★ Insight
Changing `UserSettings` to `Record<string, unknown>` is cleaner than adding an index signature — it avoids the footgun where narrower typed properties shadow the catch-all. The cast on `enabledPlugins` at the call site is explicit and localized rather than baked into the interface shape.

---

<!-- insight:e997aeb489b2 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-29T14:29:01.731Z -->
## ★ Insight
The V5.5 implementation is bottom-up: types first so TypeScript catches mismatches everywhere else before we touch the UI. The `SettingsKeyEntry` shape intentionally uses `unknown` for `value` rather than `JsonValue` — the settings file is user-controlled and can hold arbitrary shapes, so the UI just previews it rather than trying to type it precisely.

---

<!-- insight:5036c649aff9 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-29T12:30:31.680Z -->
## ★ Insight
`vi.mock("os")` replaces the module in Vitest's ESM registry, but `apply.ts` already holds a bound reference to the original `os` object by the time the test runs. `vi.spyOn` patches the property directly on the module singleton, which is the same object every importer holds — so it reliably intercepts calls in any module.

---

<!-- insight:1f2c468a2850 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-29T12:25:17.370Z -->
## ★ Insight
- `vi.hoisted()` runs its callback *before* module hoisting, so you can safely use its return value inside `vi.mock` factories — the plain `let tmp = ""` pattern relies on the factory reading the variable lazily at call time, which often works but isn't guaranteed by the spec.
- Dispatcher-level integration tests have a different contract than primitive tests: they prove the right source is selected (getUserConfig vs. scanners) and the right params are threaded through, not that the write is bit-for-bit correct. End-to-end (real write) achieves both in one pass.

---

<!-- insight:c3313131e0d4 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-29T00:58:13.693Z -->
## ★ Insight
- **The source field on the entry shape is already doing the work for two of the four primitives.** `HookEntry.source` and `McpServer.source` are already on the data — applyHook can derive the warning from `entry.source === "user"` without any new parameter. applyPlugin and applySettings don't have a source field on their input (just a plugin key or a settings path), so they need an explicit `sourceScope` flag. This asymmetry is fine: it maps to whether the data itself encodes provenance.
- **Why the warning is louder for plugins than hooks:** A user-scope plugin enable is *already* globally active on the source machine. Templating it to a project means saying "everyone using this repo also gets this plugin enabled when they have it installed." That's a much bigger commitment than copying a single hook.

---

<!-- insight:6a231696bf42 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-29T00:55:13.225Z -->
## ★ Insight
- **Param overload is a code smell that tests can't catch.** `applyHook`'s `sourceProjectPath` was doing two separate jobs (script resolution + rejection target) — they happened to want the same value when the only source kind was `project`. Splitting them now, before adding user-scope, is cheaper than splitting them later when one job has multiple call sites with different semantics.
- **Symmetric features need symmetric treatment.** The advisor caught that `dispatchSettings` has the *same* gap as hook/mcp/plugin — I'd planned to do three but missed the fourth. They're all "read from a different source, dispatch to the same primitive." Doing them as a set is one PR; deferring one to V5.x means future-me re-deriving the same context.

---

<!-- insight:091540acf5eb | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T21:57:48.950Z -->
## ★ Insight
The PR #29 review caught what I'd consider a CVE-class bug — **`__proto__` prototype pollution via crafted template manifests** — that no other test suite or smoke test would have surfaced. The lesson worth carrying forward: **any time user-controlled strings flow into bracket-property assignment (`obj[seg] = …`), there's a prototype-pollution vector**. The fix pattern (deny-list at the path validator + a regression test that asserts `Object.prototype` is genuinely untouched) is the canonical defense. The Copilot bot deserves credit — that finding was specific, accurate, and exactly the kind of thing humans miss in their own code.

---

<!-- insight:d53d48d4f62c | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T21:45:12.889Z -->
## ★ Insight
The most dangerous of the nine is **`__proto__` prototype pollution in `setJsonPath`**. Settings paths come from user-controlled template manifests; a manifest with `unit.key = "__proto__.polluted"` would mutate `Object.prototype`, contaminating every object in the running process. This is the same primitive that famously took down lodash and several other widely-used libraries — a textbook attack on JSON-walker code that uses bracket assignment with arbitrary string keys. The fix is a simple deny-list at the segment validator, but missing it would have been a CVE-class bug.

---

<!-- insight:471d9cb5d331 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T21:15:22.427Z -->
## ★ Insight
The simplify pass surfaced a layering bug that was *invisible* until the helper-extraction made it concrete: client components were transitively importing `fs` and `child_process` through `manifest.ts → atomicFs → fs` and `manifest.ts → config → platform → child_process`. Next.js had been silently tree-shaking it, but the moment a client component reached for `inventoryCount`, the full graph crossed the server/client boundary and Turbopack failed. The fix — extracting pure helpers into `inventoryUtils.ts` — is the right architectural shape regardless of the simplify finding; it makes the client/server split explicit at the import-graph level rather than relying on tree-shaking to paper over the leak.

---

<!-- insight:aa88eb97a7cc | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T21:08:28.150Z -->
## ★ Insight
The ternary-cascade bug in `route.ts` is a textbook case of **parallel mappings drifting**. When V3 added `workflow` and V4 added `settingsKey`, each addition required edits in *two* places: `inventoryKeyFor` (`manifest.ts`) AND the ternary cascade (`route.ts`). Both got updated correctly here, but the structure invites future drift. Replacing the cascade with the existing helper makes `manifest.ts` the single source of truth.

---

<!-- insight:a5a5e14c4e7d | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T20:57:41.510Z -->
## ★ Insight
The most subtle part of V4 was `mergeValues`'s **path-preservation through nested merges**. When the user picks `permissions` (whole object) instead of `permissions.allow`, the merge of the parent should *still* trigger concat-dedupe at the child path. That works because `mergeValues` recurses with `keyPath = "${keyPath}.${k}"` rather than starting fresh — by the time it hits the `allow` array, `isConcatDedupePath("permissions.allow")` returns true even though the user-facing unit key was just `permissions`. Without that path threading, the concat-dedupe semantics would be invisibly inconsistent depending on what granularity the user picked.

---

<!-- insight:bc32f685a7cc | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T20:42:52.774Z -->
## ★ Insight
`applySettings` closes the largest remaining gap in Template Mode: most users care more about templating their `permissions.allow` list (which controls Bash command auto-approval) than they do about the specialized hook/plugin/MCP paths. The implementation hinges on getting the merge semantics right — what should happen when both source and target have `permissions.allow: ["Bash(git:*)", "Read(*)"]` overlapping with `["Bash(git:*)", "Edit(*)"]`? Concat-and-dedupe vs replace vs error is a documented contract, not just an implementation detail.

---

<!-- insight:ee22332bcc60 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T20:40:05.819Z -->
## ★ Insight
The merge surfaced an instructive layering of branch-protection signals: `mergeable: MERGEABLE` (no conflicts) but `mergeStateStatus: BLOCKED` (rule violation). The two are independent — GitHub will report mergeable at the file level even when policy blocks. The blocker here was `required_review_thread_resolution: true` in the ruleset — bot-flagged threads need explicit resolution, not just a reply. Worth knowing for any future PR with bot reviewers: queue up `gh api graphql -f query='mutation { resolveReviewThread(input: { threadId: ... }) }'` calls as part of the post-fix workflow rather than discovering it at merge time.

---

<!-- insight:d585c4a301b5 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T20:36:12.398Z -->
## ★ Insight
Three of the eight comments traced to the same architectural flaw: `dryRun` had been implemented as **"skip the final write"** rather than **"skip *all* mutations."** Bootstrap mkdir+git init, `applyDirectory`'s `fs.rm`, and `applyPlugin`'s no-op write all sat above the `if (dryRun)` check. The discipline going forward: dry-run paths should be implementable as a side-effect-free function that returns `{ok, status: "would-apply"}` — anything that mutates disk before that check is a bug.

---

<!-- insight:e64e396d846e | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T20:26:14.181Z -->
## ★ Insight
Three of these are the same class of bug: **dry-run paths that aren't actually dry**. Comment #1 (bootstrap mkdir + git init in preview), #6 (`fs.rm` before checking dryRun), and partly #8 (dry-run claims it would write when it wouldn't) all share the same root: dry-run was implemented as "skip the final write" instead of "skip *all* mutations." That's a design smell worth being deliberate about — the fix isn't just three patches, it's a discipline I should apply across the apply layer.

---

<!-- insight:ac8bc2ffc625 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T20:01:53.377Z -->
## ★ Insight
The bundled-skill polish illustrates a small but important UX pattern: **dry-run previews should show the *consequences* of a click, not just confirm it'll happen**. A directory copy that just says `[copy directory] foo/ → bar/` is a tautology. Listing the actual files (12 with truncation) turns the preview from acknowledgment into information — "oh, this skill ships a `helper.css` I didn't realize was part of it." For high-stakes actions like cross-project copy, that visibility shifts the user from hopeful to confident.

---

<!-- insight:4f9e446332a0 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T19:31:03.544Z -->
## ★ Insight
The criteria I'm using to sort follow-ons:
- **Pre-PR essentials** = things a reviewer will catch and you'll have to add anyway
- **Polish (small, completes the story)** = items deferred *during* V1–V3 that would feel incomplete to leave for later
- **Defer to V4+** = items unrelated or large enough to deserve their own PR — bundling them dilutes the V3 narrative

---

<!-- insight:59a70da62fca | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T19:26:30.202Z -->
## ★ Insight
Two patterns made V3 cheap:
- **`inventoryKeyFor(kind)` with exhaustiveness check** — adding new unit kinds previously meant grepping for every place that mapped UnitKind to plural inventory key. Now there's one switch with a `never` fallback, and TypeScript fails the build if you forget to handle a new kind. This is what made adding `plugin` then `workflow` back-to-back a 5-minute change in the manifest layer.
- **The "virtual project root" abstraction from V2 paid off again** — workflow apply just reuses `dispatchWorkflow(source, target)` with `source.path` resolved through the same machinery. Snapshot bundles already mirror a real project's `.github/workflows/` layout, so promoting `applyWorkflow` to a unit kind required zero changes in `resolveTemplateSourcePath`.

---

<!-- insight:dcabbfb18e21 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T18:30:11.989Z -->
## ★ Insight
The architectural choice that paid off most in V2 was making snapshot bundles mirror a real project's `.claude/` layout. That single decision meant:
- `walkProjectAgents`, `walkProjectSkills`, `walkProjectCommands`, `scanClaudeHooks`, `scanMcpServers` all became snapshot readers for free — zero new code paths to maintain.
- The smoke test confirmed it works end-to-end: applying the snapshot template produced an *identical* dispatch result to applying the live template, because both flavors resolved to a "virtual project root" the existing scanners read uniformly.
- A user can `cd` into `<devRoot>/.minder/templates/<slug>/bundle/` and the `.claude/` looks exactly like a real project's. They can edit, diff, version it. Custom asset layouts make snapshots opaque — this design keeps them inspectable.

---

<!-- insight:b0275c6627ca | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T18:11:33.660Z -->
## ★ Insight
Why mirror the source project's directory layout inside the bundle instead of inventing a new manifest schema with assetPaths? Two reasons:
- **Reuse**: every existing scanner becomes a snapshot reader for free. No second code path to maintain or test.
- **Inspectability**: a user can `cd` into a snapshot bundle and the `.claude/` looks exactly like a real project's `.claude/`. They can edit it, diff it, version it. Custom asset layouts make snapshots opaque.

---

<!-- insight:fcbb690bd436 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T17:59:46.738Z -->
## ★ Insight
The default behavior of "auto-dismiss on success" is a UX trap whenever success carries actionable info. For Template Mode, *every* hook copy from a `settings.local.json` source carries a warning the user must act on (the hook is now project-shared, visible to teammates). Auto-closing through that warning silently strands the user with state they didn't realize they needed to know about. The fix wires the timer to the *quality* of the result, not just `ok: true`.

---

<!-- insight:a7083a94d7df | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T17:24:38.630Z -->
## ★ Insight
Two design choices proved their worth during smoke testing:
- **Server-side hook expansion** (one row per invocation) caught the multi-command bug the advisor flagged. Without it, a `PostToolUse|Edit` tuple with two commands would silently copy only the first when the user clicked the button.
- **Read from indexed `McpServer` shape, not raw `.mcp.json`** — this is the env-secret-leak guard. The smoke test confirmed env keys land at the target as empty strings. If `applyMcp` had re-read the source file, the env *values* would have followed. Read-side and write-side invariants must match.

---

<!-- insight:76de8838cef1 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T16:59:48.003Z -->
## ★ Insight
Two design choices worth understanding:
- **`ensureInsideDevRoots` uses `path.relative` instead of `startsWith`** — `startsWith` gives false positives like `C:\dev\foo` matching `C:\dev`'s prefix even when the resolved path is `C:\dev\foobar`. `path.relative` gives a `..`-prefixed result for true escapes and correctly handles trailing separators.
- **`hookKey` hashes the command** — a single `event+matcher` tuple can carry multiple commands (e.g., two `PostToolUse|Edit` hooks). Without hashing the command into the key, idempotent apply would either over-apply (writing both each time) or under-apply (treating them as the same unit). 16 hex chars of sha256 is plenty for collision avoidance at human-config scale.

---

<!-- insight:b24b158e360f | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T16:56:51.028Z -->
## ★ Insight
A subtle reason this plan ships in three phases: every later phase depends on read-side invariants you've already enforced. V1 leans entirely on the existing scanner/indexer outputs (which already dedupe, redact secrets, and carry `sourcePath`). V2 adds the template manifest as a thin layer over those same outputs. V3 adds polish without touching the core pipeline. The hardest part is V1's apply layer — once that's solid, V2 and V3 are mostly UI and orchestration.

---

<!-- insight:e9c7c490e26f | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T16:51:44.145Z -->
## ★ Insight
Two architectural patterns drive this plan and are worth flagging:
- **Identity-keyed hooks (`event|matcher|sha256(command)`)** — without hashing the command into the key, idempotent re-apply silently double-writes when a single `event+matcher` pair has multiple commands. Same trick is why Git keys blobs by content hash, not filename.
- **Live + snapshot template duality** — both the user's mental model ("a template is a real project I maintain") and the safety win ("a template is a frozen point-in-time copy") get satisfied by making `kind` a manifest field with uniform `resolveTemplateAssets()` resolution. Reader code never branches on `kind`, only the writer does.

---

<!-- insight:d1e6ae84d664 | session:6f96f34a-6a76-44a4-a686-602ae5220bca | 2026-04-28T16:46:56.524Z -->
## ★ Insight
The most consequential design choice for Template Mode is whether a "template" is a **vendored snapshot** (a frozen copy at `<devRoot>/.minder/templates/<slug>/`) or a **live project flagged as template** (any project tagged `isTemplate: true` in `.minder.json`). Vendoring is more stable — edits to a source project don't silently change the template — but it duplicates data. Flagging is leaner but means your template drifts whenever you tweak the source. This decision changes the manifest shape, the API, the UI, and the test surface.

---

<!-- insight:ab23b3b8224d | session:f25d4efc-f1ec-4403-bbf7-6fcab73d7cda | 2026-04-27T15:38:20.892Z -->
## ★ Insight
The `CatalogActionStrip` duplication is a classic structural isomorphism: `SkillRow.entry` and `AgentRow.entry` share identical base fields (`provenance`, `realPath`, `filePath`) because both are shaped from `CatalogEntryBase`. Extracting the action strip just needs a minimal structural interface for those three fields — no need to import the full `CatalogEntry` type.

---

<!-- insight:5b82ea716de0 | session:f25d4efc-f1ec-4403-bbf7-6fcab73d7cda | 2026-04-27T15:29:57.439Z -->
## ★ Insight
The test files in this project use a clear pattern: `vi.mock("fs")` at module level, import `promises` *after* the mock declaration (hoisting ensures the mock is in place first), and a `beforeEach(() => vi.clearAllMocks())` to prevent state leakage. Pure logic functions like `resolveProvenance` can be tested directly without any mocking at all.

---

<!-- insight:182e78505325 | session:f25d4efc-f1ec-4403-bbf7-6fcab73d7cda | 2026-04-27T15:20:00.651Z -->
## ★ Insight
The reveal endpoint needs path validation before shelling out. The safest approach is checking the path starts with one of a known set of roots (`~/.claude`, `~/.agents`, devRoot) — not a regex, but a `startsWith` on the resolved absolute path. Never trust the raw request body verbatim.

---

<!-- insight:98452ef47c31 | session:f25d4efc-f1ec-4403-bbf7-6fcab73d7cda | 2026-04-27T15:14:31.390Z -->
## ★ Insight
The warming pattern is fire-and-forget: we enqueue entries after building the response, not before. This keeps response latency fast while populating the background cache so the polling endpoint starts returning results shortly after.

---

<!-- insight:717ec6390b93 | session:f25d4efc-f1ec-4403-bbf7-6fcab73d7cda | 2026-04-27T15:14:01.818Z -->
## ★ Insight
The `skills/route.ts` pattern shows how to warm caches: load catalog, then immediately enqueue entries into the background cache. The `git-status/route.ts` shows how thin the polling endpoint can be — the cache singleton does all the heavy lifting. We'll mirror both patterns.

---

<!-- insight:76d3c84e363c | session:f25d4efc-f1ec-4403-bbf7-6fcab73d7cda | 2026-04-27T15:11:23.496Z -->
## ★ Insight
- The API returned 69 lockfile skills and 10 user-local skills — exactly the distribution we expected from disk inspection. Symlinks are resolved correctly and the `symlinkTarget` field carries the real `.agents/skills/` path.
- Marketplace plugins show `marketplaceRepo: "supabase/agent-skills"` from `known_marketplaces.json` joined to the plugin key's `@supabase-agent-skills` suffix. The `gitCommitSha` and install dates flow through intact.
- The `ProvenanceBadge` receives the full `Provenance` union at render time — all downstream components (skills, agents, per-project tabs) use the same component, so any future changes (like adding the update dot) happen in one place.

---

<!-- insight:ab7f918966cc | session:f25d4efc-f1ec-4403-bbf7-6fcab73d7cda | 2026-04-27T15:06:17.232Z -->
## ★ Insight
- The project uses inline styles throughout (no CSS modules or Tailwind classes in components) — matching this pattern is important for consistency.
- The `SourceBadge` pattern is simple enough that `ProvenanceBadge` can be a drop-in replacement: same container styles, richer label logic.
- The expanded row provenance block follows the existing pattern: a `marginLeft: "20px"` inner block with labeled monospace details.

---

<!-- insight:c60bd3bd2f5a | session:f25d4efc-f1ec-4403-bbf7-6fcab73d7cda | 2026-04-27T15:01:33.065Z -->
## ★ Insight
- The real `.skill-lock.json` schema is `{ version: N, skills: {...}, dismissed: {...} }` — skills are under a `skills` key, not at the top level. The explore agent's assumption was right but the code needs to access `data.skills`.
- User skills in `~/.claude/skills/` are directory symlinks (e.g. `clerk/ → C:\Users\joshu\.agents\skills\clerk`), while loose `.md` files are real files. The `Dirent.isSymbolicLink()` + `fs.realpath()` combo handles both.
- The `installed_plugins.json` marketplace key is the short form (`claude-plugins-official`), and `known_marketplaces.json` maps that to the full `owner/repo` (e.g. `anthropics/claude-plugins-official`). These two files together give us the full provenance chain.

---

<!-- insight:c6600c6480c4 | session:f25d4efc-f1ec-4403-bbf7-6fcab73d7cda | 2026-04-27T14:53:07.813Z -->
## ★ Insight
- The plan deliberately splits **detection** (cheap, idempotent network calls) from **action** (shell-out and CLI orchestration). Detection runs in the background and is read-only; the only shell-out we ship is `explorer /select,<path>` for "reveal in folder" — even that is path-validated before execution.
- Update *commands* are kept as a **user-supplied hint** in `.minder.json` rather than hardcoded. This is the same posture Project Minder takes elsewhere: filesystem is the source of truth, user prefs are explicit. It also future-proofs against the Claude CLI surface changing.
- Adding `provenance` to `CatalogEntryBase` (rather than separately to `SkillEntry` and `AgentEntry`) is the lever that makes "both catalogs at once" cheap. The UI extraction of `<ProvenanceBadge>` does the same on the rendering side.

---

<!-- insight:e04a29676902 | session:f25d4efc-f1ec-4403-bbf7-6fcab73d7cda | 2026-04-27T14:49:16.253Z -->
## ★ Insight
- `walkPlugins.ts:38-39` confirmed — `key.lastIndexOf("@")` already extracts the marketplace name, but only `pluginName` is kept. The marketplace is one trivial line away from being captured.
- `gitStatusCache.ts` is a clean ~100-line template: enqueue → batched processQueue → 5-min TTL → singleton via `globalThis`. Copying its shape for `skillUpdateCache.ts` keeps the codebase coherent.
- `SkillEntry` and `AgentEntry` both extend `CatalogEntryBase` — adding `provenance` to the base type lifts both at once for free.

---

<!-- insight:4f8ed0a1a35b | session:f25d4efc-f1ec-4403-bbf7-6fcab73d7cda | 2026-04-27T14:46:05.841Z -->
## ★ Insight
- The disk has **far more provenance than the indexer captures**. `installed_plugins.json` already records `gitCommitSha`, `version`, `installedAt`, `lastUpdated`, and the marketplace name (encoded in plugin keys like `pluginname@marketplace`). The indexer (`walkPlugins.ts:38-49`) currently splits the `@marketplace` off and throws it away.
- A second, parallel install system exists: `~/.agents/.skill-lock.json` is a real lockfile keyed by skill name with `sourceUrl`, `skillFolderHash`, and `installedAt`/`updatedAt`. Most user skills under `~/.claude/skills/` are **symlinks** into `~/.agents/skills/`. Project Minder doesn't read either today.
- Five distinct provenance classes exist: marketplace plugin, lockfile-installed (`~/.agents`), user-authored loose files, project-scoped, and CLI-built-in (no disk presence). Each has a different update story.

---

<!-- insight:146df123829c | session:e2734b36-5cf9-4ce9-89e6-02de1dfbedea | 2026-04-27T14:12:15.670Z -->
## ★ Insight
The comments fall into three categories: **correctness** (slug normalization in components, alias map first-wins, ID collisions), **performance** (O(n²) session dedup), and **defensive robustness** (frontmatter parsing, scoped plugin names, cache invalidation). Fixing them in one commit keeps the branch history clean.

---

<!-- insight:cc85f34edb20 | session:e2734b36-5cf9-4ce9-89e6-02de1dfbedea | 2026-04-27T14:00:19.092Z -->
## ★ Insight
This is a classic **composite key** problem: using only the leaf name as an identifier works fine until two different paths share the same leaf. The relative path from the root is the natural unique key for file-system entries — it's essentially what the filesystem itself uses as an address. The display `slug` (basename) and the identity `id` (relative path) are now separate concerns.

---

<!-- insight:cec38a71a915 | session:e2734b36-5cf9-4ce9-89e6-02de1dfbedea | 2026-04-27T13:34:20.004Z -->
## ★ Insight
The slug utility (`src/lib/usage/slug.ts`) is a textbook **single source of truth** fix. The routes were technically correct after the earlier bug fix, but having the same 2-line function in two places means the next person who touches `encodePath` or `toSlug` semantics (e.g., to handle a new OS path format) only has one place to update — and the type system will propagate it automatically to every consumer at compile time, rather than silently leaving one copy stale.

---

<!-- insight:a168cc1c156a | session:e2734b36-5cf9-4ce9-89e6-02de1dfbedea | 2026-04-27T13:23:21.986Z -->
## ★ Insight
The slug mismatch (scanner: `project-minder` vs usage: `c--dev-project-minder`) is a pervasive pattern in this codebase. The scan cache uses short directory-basename slugs, while the Claude session cache encodes the full Windows path. The fix needs to happen at the join point — the API route — where both formats are available.

---

<!-- insight:868440f39a1a | session:e2734b36-5cf9-4ce9-89e6-02de1dfbedea | 2026-04-27T13:02:13.712Z -->
## ★ Insight
The browser uses a single `useAgents(undefined, undefined, debouncedQuery)` call rather than passing source/sort as params — filtering and sorting happen client-side after the response lands. This avoids busting the server-side cache on every filter toggle and keeps interactions instant once data is loaded. The tradeoff: all ~200+ entries are in memory client-side, which is fine for a personal dashboard.

---

<!-- insight:e97217abc641 | session:e2734b36-5cf9-4ce9-89e6-02de1dfbedea | 2026-04-27T12:58:32.314Z -->
## ★ Insight
The walker uses `fs.stat` (not `lstat`) to check file types so it follows symlinks by default — but we explicitly skip symlink directory entries by using `dirent.isSymbolicLink()` when recursing. This avoids following circular references in plugin cache layouts while still allowing symlinked `.md` files to be read.

---

<!-- insight:be9b35e19c6f | session:e2734b36-5cf9-4ce9-89e6-02de1dfbedea | 2026-04-27T12:57:05.421Z -->
## ★ Insight
`js-yaml`'s `load()` with `JSON_SCHEMA` is safe for structured config YAML. But skill/agent descriptions are general human-written YAML — the `DEFAULT_SCHEMA` (standard YAML) handles more types. Either way, the critical safety is the `try/catch` around the parse call; descriptions frequently have embedded XML tags or colons mid-string that can trip any YAML parser.

---

<!-- insight:749d223dd956 | session:e2734b36-5cf9-4ce9-89e6-02de1dfbedea | 2026-04-27T12:55:14.326Z -->
## ★ Insight
Two decisions in the plan worth flagging because they materially shrink scope vs. the obvious approach:

---

<!-- insight:927047fe4a30 | session:e2734b36-5cf9-4ce9-89e6-02de1dfbedea | 2026-04-27T12:27:46.064Z -->
## ★ Insight
- The aggressive MVP's clever idea: **most usage data already exists at the session level** (`skillsUsed`, `subagents[]`) — we don't need to modify the parser. We just need a small new aggregator that reads existing `UsageTurn[]` data, mirroring `mcpParser.ts`. This avoids the risky `parser.ts:102` sidechain re-inclusion entirely for v1.
- The comprehensive plan's stronger point: **plugin coverage matters here.** ~half of skills the user invokes (vercel:*, clerk-setup, commit-commands:commit) come from plugins. Skipping plugins creates orphan rows for the most-used skills. Better to walk plugin directories in v1, with name-prefix synthesis as a fallback for unmatched invocations.
- A subtle name-canonicalization gotcha: `subagent_type` and `Skill.input.skill` are runtime free-form strings. Frontmatter `name:` is sometimes Title Case, sometimes kebab-case. The catalog needs an alias map (slug + frontmatter `name:` + lowercased forms + `pluginName:slug` for plugins) to join cleanly.

---

<!-- insight:5d6280a3ca89 | session:bba9cb80-aca3-449f-ac6a-bc881e79a825 | 2026-04-23T01:53:36.292Z -->
## ★ Insight
npm's pre-release semver handling is a common gotcha: `^7.0.0-dev.20260422.1` DOES allow newer `7.0.0-dev.*` builds on `npm install` (same-major, higher pre-release tuple), even though the lockfile pins the exact version for `npm ci`. Copilot's suggestion is correct — a bare version string prevents silent drift on local `npm install` runs, making the intent explicit: "only bump tsgo deliberately."

---

<!-- insight:1a3cf8895b70 | session:bba9cb80-aca3-449f-ac6a-bc881e79a825 | 2026-04-23T01:20:58.746Z -->
## ★ Insight
CLAUDE.md serves as the project's "prime directive" for future AI sessions — it's the first thing any Claude session reads. Keeping it accurate matters more here than in a typical README: a stale CLAUDE.md will cause future sessions to give wrong advice (e.g., "run npm run build to type-check" after we've added a dedicated 10x-faster alternative).

---

<!-- insight:72a827e8e62d | session:bba9cb80-aca3-449f-ac6a-bc881e79a825 | 2026-04-22T20:37:14.045Z -->
## ★ Insight
The CI workflow uses a **step-based** pipeline where each step is an independent shell command. Adding `npm run typecheck` as its own step (vs. folding it into the build step) means GitHub Actions reports it separately in the UI — you'll see `Type-check (tsgo)` as its own expandable tile, with its own timing and log, making it easy to distinguish a typecheck failure from a build failure.

---

<!-- insight:38ca5daa774e | session:bba9cb80-aca3-449f-ac6a-bc881e79a825 | 2026-04-22T20:36:33.561Z -->
## ★ Insight
The `package.json` stores all deps as a flat JSON — no `npm pkg set` command needed. I'll edit it directly. The `@typescript/native-preview` version is pinned with `^` so it'll resolve future dev releases automatically, but always within the `7.0.0-dev.*` range (semver pre-release rules don't allow `^` to cross pre-release boundaries, so this effectively pins to the `7.0.0-dev.*` train).

---

<!-- insight:be3e90793e4b | session:bba9cb80-aca3-449f-ac6a-bc881e79a825 | 2026-04-22T18:20:31.597Z -->
## ★ Insight
**Why Step 3 is the right place for your input:** the three wiring options trade CI cost, developer friction, and safety differently — and the "right" choice depends on team preferences this codebase's CLAUDE.md doesn't disclose. The plan is written so the default (CI + pre-commit) works if you just say "go," but picking differently shapes the commit experience meaningfully.
**Why `typescript` still bumps to 6:** Next.js 16's build pipeline calls `require("typescript")` for its internal typecheck. If we pin to `^5` while adopting tsgo, we'd be running TS 5.9 diagnostics in `next build` and TS 7-parity-with-5.9 in `tsgo` — essentially the same checker twice. Bumping classic to 6 gives us two *different* type checkers cross-validating each other, which is the real insurance while TS 7 is still preview.

---

<!-- insight:459bc33c35f1 | session:bba9cb80-aca3-449f-ac6a-bc881e79a825 | 2026-04-22T18:19:07.142Z -->
## ★ Insight
**TypeScript 7.0 doesn't ship on the `typescript` npm package.** It's published separately as `@typescript/native-preview` (current beta tag: `7.0.0-dev.20260421.2`, latest: `7.0.0-dev.20260422.1`). Meanwhile, the classic JS-based `typescript` package has moved on to `6.0.3` as `latest`. So this is a **two-track** situation — the Go rewrite lives alongside the classic compiler during the preview phase, not as a successor version of the same package.
**Why that matters here:** Next.js 16's build pipeline (`next build`) loads `require("typescript")` for its own typecheck — it doesn't know about `tsgo` yet. If we replace `typescript` entirely, `next build` breaks. The realistic upgrade is **additive**: keep `typescript` (bumped 5→6 for freshness), add `@typescript/native-preview`, and use `tsgo --noEmit` as a fast standalone gate.

---

<!-- insight:7b80fb4fcf0e | session:bba9cb80-aca3-449f-ac6a-bc881e79a825 | 2026-04-22T18:15:18.501Z -->
## ★ Insight
TypeScript 7.0 is the Go-based native port of the compiler (announced March 2025) — it's a rewrite in Go that targets ~10x performance for type-checking. That means the upgrade is primarily a **compiler swap**, not a language-version jump: your `.ts` files don't need new syntax, but your tooling chain (Next.js, Vitest, IDE) has to know how to talk to the new binary.

---

<!-- insight:552d6555dc57 | session:43f436f3-6232-468c-a338-717d7506a643 | 2026-04-22T02:33:48.876Z -->
## ★ Insight
A good README update mirrors the existing voice and section structure rather than rewriting from scratch — readers already have a mental model of the layout, so the new entries should feel like they were always there.

---

<!-- insight:e80e53ad45d5 | session:43f436f3-6232-468c-a338-717d7506a643 | 2026-04-22T02:11:55.927Z -->
## ★ Insight
The slug mismatch is a path encoding impedance problem: the Claude project dirs encode the full Windows path (`C--dev-project-minder`) while `ProjectData.slug` is derived from just the basename (`project-minder`). The fix is to decode → take basename → slugify, the same chain the scanner uses.

---

<!-- insight:839271a0f59d | session:43f436f3-6232-468c-a338-717d7506a643 | 2026-04-22T01:58:41.150Z -->
## ★ Insight
- The `lastToolName` state is computed from the last-seen `tool_use` block in the last assistant turn — even if that tool was resolved. For unresolved tools it tells you what's pending; for resolved turns it shows what was last run. Dual-purpose information from a single variable.
- Moving `MarkdownContent` to its own file avoids a circular import: `ProjectDetail` would import `MemoryTab`, and `MemoryTab` would import `MarkdownContent` from `ProjectDetail` — breaking the module graph.

---

<!-- insight:71ade246055f | session:43f436f3-6232-468c-a338-717d7506a643 | 2026-04-22T01:49:11.073Z -->
## ★ Insight
- Separating "enumeration" (`scanAllSessions`) from "classification" (`liveSessionStatus`) means each piece stays single-responsibility — the classifier is pure and table-testable, while the walker already handles the filesystem quirks of worktree dirs.
- The `?file=<name>` on-demand fetch for memory content mirrors how the Sessions API works (summary list up front, full detail on click) — keeps initial tab-open payload small even if memory grows to hundreds of files.

---

<!-- insight:a85c3c3b2b80 | session:43f436f3-6232-468c-a338-717d7506a643 | 2026-04-22T01:47:52.388Z -->
## ★ Insight
- The 4-state classifier can wrap (not replace) `inferSessionStatus()` — we add a new "approval" branch *before* the mtime age check, keeping the proven pairing logic intact.
- A cross-poll mtime cache turns a single-shot snapshot into a rate-of-change signal: "stalled since last poll" is a much stronger waiting/approval signal than any single mtime reading.
- `encodePath()` is reused everywhere (`C:\dev\foo` → `C--dev-foo`), so Claude memory directories are addressable without any new mapping code — the filesystem already speaks our project key.

---

<!-- insight:746fd1162596 | session:43f436f3-6232-468c-a338-717d7506a643 | 2026-04-21T20:32:46.469Z -->
## ★ Insight
- Project Minder already has the backbone: `src/lib/scanner/sessionStatus.ts` infers `"working" | "needs_attention" | "idle"` from pending `tool_use` IDs versus matched `tool_result` IDs — exactly the signal c9watch uses in Rust. The user's four-state ask (working/approval/waiting/other) is mostly a richer taxonomy over data we already parse.
- "Awaiting approval" is **not** a first-class field in the JSONL — Claude Code's permission prompts never hit disk. So we infer it: an unresolved `tool_use` on a high-risk tool (Bash/Write/Edit) combined with a stalled mtime is the most honest proxy. That's what c9watch does too; the Rust code just has a 2-second poll that makes the stall detection feel snappier.
- The Memory tab is the easier half — real data already exists at `C:\Users\joshu\.claude\projects\C--dev-project-minder\memory\`, `encodePath()` is already in `claudeConversations.ts:51`, and `ProjectDetail.tsx` uses a plain `<button>` tab row (not Radix Tabs), so adding a new tab is one enum entry + one content block.

---
