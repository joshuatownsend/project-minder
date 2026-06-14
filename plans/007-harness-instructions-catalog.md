# Plan 007: Harness-source abstraction for the agents/skills indexer (Codex/Gemini instructions catalog)

> **Status: DEFERRED design (not yet built).** Captured 2026-06-14 from the
> multi-harness workflow's investigation of TODO item 5. This is a real feature
> (new catalog category + route + UI) with product decisions, **not** a path
> swap — it was deliberately not auto-implemented. Pick it up when prioritized.

## Status

- **Priority**: P3
- **Effort**: M–L
- **Risk**: MEDIUM (new type + route + UI; touches the indexer assembly)
- **Depends on**: none hard; conceptually follows #1 (ingest keystone, shipped)
- **Category**: feature / direction
- **Planned at**: commit `408ce0c` (post-#209)

## Why this matters

The catalog indexer surfaces Claude **agents** and **skills** only. Codex
(`~/.codex/rules/*`, `AGENTS.md`, `prompts/`) and Gemini have their own
instruction/agent artifacts that are invisible in Project Minder today. Once a
user enables those adapters (#1), surfacing their instruction artifacts in a
unified catalog closes the last "Claude-only" gap (#6 in the parity matrix,
`docs/adapters/multi-harness-parity.md`).

The decisive constraint (verified): Codex `rules`/`AGENTS.md` are **a different
artifact** than Claude agent/skill profiles — they are user-authored prose, with
no `model`/`tools`/`layout`. So they should NOT be forced into `AgentEntry` /
`SkillEntry`.

## Current state (entry points)

- `src/lib/indexer/types.ts` — `CatalogSource = "user" | "plugin" | "project"`
  (**filesystem origin, NOT harness**); `CatalogEntryBase` (id/slug/name/source/
  filePath/frontmatter/fileBytes/projectedContextCost/…); `AgentEntry` (kind
  "agent" + model/tools/color), `SkillEntry` (kind "skill" + layout/version);
  `CatalogResult = { agents, skills }`.
- `src/lib/indexer/catalog.ts` — `loadCatalog({includeProjects})` runs the walks
  in parallel, dedups, caches (5-min TTL), returns `CatalogResult`. This is where
  new gated walks plug in.
- `src/lib/indexer/walkAgents.ts` — **the pattern to mirror**: entry factory
  (`makeAgentEntry`), defensive file reader (`readAgent`), recursive `walkDir`
  (depth cap, symlink resolution, `.md` filter, category tagging), public
  `walkUser/Plugin/Project*` functions. `walkCommands.ts` is the same shape.
- `src/lib/adapters/codex.ts:478` — **`readCodexRules(home)` already exists**
  (reads `~/.codex/rules/*.{rules,md,txt}` with a per-file cap). Reuse its file
  discovery; the catalog walker adds frontmatter parsing + entry construction.
- `src/lib/scanner/parseFrontmatter.ts` (used by walkAgents) — defensive YAML
  frontmatter parser with `parseWarnings`.
- `src/app/api/agents/route.ts` / `skills/route.ts` + `AgentsBrowser` /
  `SkillsBrowser` — the route + UI pattern to mirror (they already support a
  per-entry filter).

## Design (recommended)

**Foundation (new walkers):**
- `src/lib/indexer/walkCodexRules.ts` — walk `~/.codex/rules/*.{rules,md,txt}`
  and `AGENTS.md`/`prompts/`; parse optional YAML frontmatter (fallback `{}`);
  build `InstructionEntry` objects; defensive (missing dir → `[]`). Resolve home
  via `$CODEX_HOME ?? ~/.codex` (reuse `resolveCodexHome` logic).
- `src/lib/indexer/walkGeminiInstructions.ts` — Gemini instruction files
  (locations TBD from Gemini docs); same entry shape. Home via
  `$GEMINI_HOME ?? ~/.gemini`.

**New type (do NOT overload `CatalogSource`):**
- `InstructionEntry extends CatalogEntryBase { kind: "instruction"; harness: "claude" | "codex" | "gemini"; }`.
  Add a separate `harness` field — keep `source` meaning filesystem origin.
- `CatalogResult` gains `instructions: InstructionEntry[]`.

**Wiring:**
- In `catalog.ts`, gate the new walks by `enabledAdapters` (read config): only
  walk Codex if `"codex"` enabled, Gemini if `"gemini"` enabled. Merge into
  `result.instructions`. Add cache keys.
- `GET /api/instructions` route (mirror `/api/agents`: caching, filtering by
  `harness`/`source`/`q`). Populate `fileBytes` (always) so the T2.1
  context-cost chip works where applicable.
- `InstructionsBrowser` page (mirror `AgentsBrowser`) with a **harness** filter.

## Product decisions (resolve before building — recommendations from the spike)

1. **Where do Codex/Gemini instruction artifacts live?** → A **new
   `instructions` catalog kind** (new `InstructionEntry`, new `CatalogResult`
   field, new `/api/instructions` + page). Cleaner than overloading `source`;
   keeps agent/skill/instruction semantics distinct.
2. **`source` vs `harness`.** → Add a separate `harness` field; do **not**
   conflate `source` (user/plugin/project) with harness identity. Expose a
   harness UI filter alongside the existing location filter.
3. **Codex vs Gemini schema equivalence.** → Assume **different** schemas;
   write separate walkers that share the `InstructionEntry` interface. Unify
   later only if both converge.
4. **`fileBytes` / `projectedContextCost` (T2.1).** → Populate `fileBytes`
   unconditionally; let `projectedContextCost` degrade gracefully for non-Claude
   models (show `?` / omit) — ties into the now-hardened non-Claude pricing.

## Tests

Mirror `tests/walkProjectCommands.test.ts`: missing-dir → `[]`; frontmatter
parse + fallback-empty; dotfile/extension filtering; symlink resolution;
per-file cap; `fileBytes` populated; malformed YAML → `parseWarnings`. Plus a
`catalog.ts` integration test: instructions present only when the harness is in
`enabledAdapters`, excluded otherwise, no id collisions.

## Verification

- `pnpm typecheck` exit 0; `pnpm test` all pass (report counts).
- With `enabledAdapters: ["claude","codex"]` and a fixture `~/.codex/rules`,
  `loadCatalog()` returns `instructions` entries with `harness: "codex"`;
  with `["claude"]` it returns none.

## Out of scope / open

- Gemini instruction file locations need confirmation from Gemini CLI docs
  before `walkGeminiInstructions` can be precise.
- No edit/apply of instruction files (read-only catalog, like agents/skills).
