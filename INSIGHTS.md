# Insights

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
