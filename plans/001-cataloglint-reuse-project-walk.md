# Plan 001: Eliminate the redundant per-project catalog re-walk in `runCatalogLint`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1b45d2b..HEAD -- src/lib/scanner/index.ts src/lib/scanner/catalogLint.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts below against the live code before proceeding. Match on the
> **code content** of each excerpt, not its line number — line numbers here are
> approximate anchors. Only a *content* mismatch (renamed symbols, changed
> logic, a walk that's no longer where the excerpt shows it) is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf / tech-debt
- **Planned at**: commit `1b45d2b`, 2026-06-13

## Why this matters

On every full scan, the scanner walks each project's `.claude/{skills,agents,commands}`
directories **twice**: once inside `scanProject` (to feed per-project config-lint)
and again inside `runCatalogLint` (to feed cross-scope duplicate-name detection).
With ~61 projects on Windows (slow filesystem), that is ~60 redundant directory
traversals of three subdirectories each, serialized after the parallel scan batch
completes. This is already flagged on `TODO.md` (under "Housekeeping → Simplification
follow-ups", `runCatalogLint re-walks project commands`) as a contributor to
pre-commit test-suite timeout bumps. The TODO mentions commands specifically, but
`runCatalogLint` re-walks **skills and agents too** — this plan removes all three
redundant walks by threading the entries `scanProject` already computed into
`runCatalogLint` via a side channel (not via `ProjectData`, which is serialized to
the client). After this lands, a full scan does one walk per project, and the
cross-scope lint reuses it.

## Current state

> The line numbers in this section are approximate (as of `1b45d2b`). Verified
> anchors you can rely on: `scanProject` at `index.ts:66`; `configLintPromise`
> at `index.ts:91`; `scanProject`'s final return object at `index.ts:183–223`
> (a ~40-field literal with a nested `claude: {…}` block); the `runCatalogLint`
> call at `index.ts:336`; `runCatalogLint` itself at `catalogLint.ts:28`, its
> project re-walks at `catalogLint.ts:43–51` and command re-walk at `54–59`.

Files involved:

- `src/lib/scanner/index.ts` — the scan orchestrator. `scanProject` (line 66) walks
  the project catalog inside `configLintPromise`; `scanAllProjects` calls
  `runCatalogLint` near the end (line 336).
- `src/lib/scanner/catalogLint.ts` — `runCatalogLint`; re-walks every project (lines 43–58).
- `src/lib/indexer/walkCommands.ts` / `walkSkills.ts` / `walkAgents.ts` — the walk
  functions (`walkProjectCommands` @207, `walkProjectSkills` @210, `walkProjectAgents` @216).
- `src/lib/indexer/types.ts` — `AgentEntry` (line 93), `SkillEntry` (line 101). The
  command entry type is the return element of `walkProjectCommands`.

### `scanProject` walks the catalog and discards the entries (`src/lib/scanner/index.ts:66–109`)

```ts
async function scanProject(
  dirName: string,
  devRoot: string,
  flags: MinderConfig["featureFlags"],
  ctx: ProvenanceContext,
): Promise<ProjectData | null> {
  const projectPath = path.join(devRoot, dirName);
  if (!(await isGitRepo(projectPath))) return null;
  const slug = toSlug(dirName);
  // ...
  // Config lint chains off audit + mcpServers + hooks + project catalog.
  const configLintPromise = getFlag(flags, "configLint")
    ? Promise.all([
        claudeMdAuditPromise,
        mcpServersPromise,
        hooksPromise,
        walkProjectSkills(projectPath, slug, ctx),    // ← walk #1 (skills)
        walkProjectAgents(projectPath, slug, ctx),    // ← walk #1 (agents)
        walkProjectCommands(projectPath, slug, ctx),  // ← walk #1 (commands)
      ]).then(([audit, mcp, hooksInfo, skills, agents, commands]) =>
        runConfigLint(projectPath, {
          claudeMdAudit: audit,
          mcpServers: mcp?.servers,
          hooks: hooksInfo?.entries,
          skills,   // consumed here, then discarded
          agents,
          commands,
        })
      )
    : Promise.resolve(EMPTY_LINT_REPORT);
```

`scanProject` returns only `ProjectData` (line 183 onward); the walked `skills/agents/commands`
never escape the closure.

### `scanAllProjects` calls `scanProject` then `runCatalogLint` (`src/lib/scanner/index.ts:300–344`)

```ts
      const batch = entries.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((d) => scanProject(d, devRoot, flags, ctx)));
      for (const r of results) {
        if (r) {
          rootProjects.push(r);
          seenSlugs.add(r.slug);
        }
      }
    }
    if (worktreesEnabled) {
      await attachWorktreeOverlays(rootProjects, allDirNames, devRoot);
    }
    allProjects.push(...rootProjects);
  }
  // ... apply statuses / port overrides / sort ...
  const portConflicts = detectPortConflicts(allProjects);
  const catalogLintFindings = await runCatalogLint(allProjects, flags, ctx);
  return { projects: allProjects, portConflicts, hiddenCount: config.hidden.length,
           scannedAt: new Date().toISOString(), catalogLintFindings };
}
```

`scanProject` has exactly **one** caller (line 301) — verified — so changing its
return type is safe and local.

### `runCatalogLint` re-walks every project (`src/lib/scanner/catalogLint.ts:28–70`)

```ts
export async function runCatalogLint(
  projects: ProjectData[],
  flags: MinderConfig["featureFlags"],
  ctx: ProvenanceContext,
): Promise<LintFinding[]> {
  if (!getFlag(flags, "configLint")) return [];
  try {
    const [baseCatalog, userCfg] = await Promise.all([
      loadCatalog({ includeProjects: false }),
      getUserConfig().catch(() => null),
    ]);
    // Walk project-scope agents/skills from the fresh scan ...
    const projectEntryResults = await Promise.all(
      projects.map(async (p) => {
        const [pSkills, pAgents] = await Promise.all([
          walkProjectSkills(p.path, p.slug, ctx),   // ← walk #2 (skills) REDUNDANT
          walkProjectAgents(p.path, p.slug, ctx),   // ← walk #2 (agents) REDUNDANT
        ]);
        return { skills: pSkills, agents: pAgents };
      })
    );
    // Walk commands across all scopes (loadCatalog doesn't cover commands)
    const [userCommands, pluginCommands, ...projectCommandSets] = await Promise.all([
      walkUserCommands(ctx),
      walkPluginCommands(ctx.installedPlugins, ctx),
      ...projects.map((p) => walkProjectCommands(p.path, p.slug, ctx)),  // ← walk #2 (commands) REDUNDANT
    ]);
    const allCommands = [userCommands, pluginCommands, ...projectCommandSets].flat();
    return runGlobalLint({
      allSkills: [...baseCatalog.skills, ...projectEntryResults.flatMap((e) => e.skills)],
      allAgents: [...baseCatalog.agents, ...projectEntryResults.flatMap((e) => e.agents)],
      allCommands,
      allPlugins: userCfg?.plugins.plugins ?? [],
    });
  } catch {
    return [];
  }
}
```

The `walkUserCommands` and `walkPluginCommands` calls are **not** redundant (no other
code walks user/plugin scope here) — keep them. Only the three **project-scope** walks
(`walkProjectSkills(p.path…)`, `walkProjectAgents(p.path…)`, `walkProjectCommands(p.path…)`)
duplicate what `scanProject` already did.

### Convention to follow

`scanProject` already hoists shared promises to avoid double-scans — see
`mcpServersPromise` and `hooksPromise` (`index.ts:88–89`), reused by both the main
`Promise.all` and `configLintPromise`. Match that exact pattern for the three walk
promises.

## Commands you will need

| Purpose   | Command                                   | Expected on success |
|-----------|-------------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                          | exit 0, no errors   |
| Tests     | `pnpm test`                               | all pass            |
| Targeted  | `pnpm test -- scannerCatalogLint`         | the catalog-lint test file passes |
| Lint      | `pnpm lint`                               | exit 0              |

(`pnpm typecheck` runs `node scripts/typecheck.mjs`, which wipes the incremental
cache first — trust its result over any cached `tsgo` run.)

## Scope

**In scope** (the only files you should modify):
- `src/lib/scanner/index.ts`
- `src/lib/scanner/catalogLint.ts`
- `tests/scannerCatalogLint.test.ts` (extend — add the two reuse cases)

**Out of scope** (do NOT touch, even though they look related):
- `src/lib/types.ts` / `ProjectData` — do NOT add the walked entries to `ProjectData`.
  `ProjectData` is serialized wholesale to the client in `src/app/api/projects/route.ts`
  (`NextResponse.json(cached)`); attaching skills/agents/commands arrays would bloat
  every `/api/projects` response. Use the side-channel map described in the steps.
- `src/lib/indexer/walk*.ts` — the walk functions themselves are correct; don't change them.
- `runConfigLint` and `runGlobalLint` signatures — unchanged.
- The `walkUserCommands` / `walkPluginCommands` calls in `runCatalogLint` — keep them.

## Git workflow

- Branch: `advisor/001-cataloglint-reuse` (NEVER work on `main` — repo rule).
- Commit style: Conventional Commits (e.g. `perf(scanner): reuse project catalog walk in runCatalogLint`).
- Do NOT push or open a PR unless the operator instructs it.

## Steps

### Step 1: Define the side-channel walk type and `scanProject`'s new return shape

In `src/lib/scanner/index.ts`, add a type near the top of the file (after the imports).
All three entry types are named exports you can import directly — verified:
`SkillEntry` and `AgentEntry` from `../indexer/types` (lines 101, 93); `CommandEntry`
from `../types` (it's `export interface CommandEntry` in `src/lib/types.ts`, already
imported by name in `configLint.ts` and `walkCommands.ts`):

```ts
import type { SkillEntry, AgentEntry } from "../indexer/types";
import type { CommandEntry } from "../types";

export interface ProjectCatalogWalk {
  skills: SkillEntry[];
  agents: AgentEntry[];
  commands: CommandEntry[];
}
```

(`src/lib/types.ts` is out of scope to *modify*, but importing a type from it is fine.)

**Verify**: `pnpm typecheck` → exit 0 (the type compiles; nothing uses it yet).

### Step 2: Hoist the three walk promises in `scanProject` and surface them

In `scanProject` (`src/lib/scanner/index.ts`), hoist the three project walks the same
way `mcpServersPromise`/`hooksPromise` are hoisted, **gated by the `configLint` flag**
(when the flag is off, neither `runConfigLint` nor `runCatalogLint` needs them):

```ts
  const mcpServersPromise = scanMcpServers(projectPath);
  const hooksPromise = scanClaudeHooks(projectPath);

  const catalogLintEnabled = getFlag(flags, "configLint");
  const skillsPromise = catalogLintEnabled
    ? walkProjectSkills(projectPath, slug, ctx)
    : Promise.resolve([] as SkillEntry[]);
  const agentsPromise = catalogLintEnabled
    ? walkProjectAgents(projectPath, slug, ctx)
    : Promise.resolve([] as AgentEntry[]);
  const commandsPromise = catalogLintEnabled
    ? walkProjectCommands(projectPath, slug, ctx)
    : Promise.resolve([] as CommandEntry[]);

  const configLintPromise = catalogLintEnabled
    ? Promise.all([
        claudeMdAuditPromise,
        mcpServersPromise,
        hooksPromise,
        skillsPromise,
        agentsPromise,
        commandsPromise,
      ]).then(([audit, mcp, hooksInfo, skills, agents, commands]) =>
        runConfigLint(projectPath, {
          claudeMdAudit: audit,
          mcpServers: mcp?.servers,
          hooks: hooksInfo?.entries,
          skills,
          agents,
          commands,
        })
      )
    : Promise.resolve(EMPTY_LINT_REPORT);
```

Now make three precise changes:

**(a) Signature return type.** Change `scanProject`'s return type from
`Promise<ProjectData | null>` to
`Promise<{ project: ProjectData; catalogWalk: ProjectCatalogWalk | null } | null>`.
The early `return null` (the non-git-repo guard at ~line 74) stays `return null` —
`null` still satisfies the new union.

**(b) Await the hoisted promises in the main `Promise.all`.** The main `Promise.all`
(starts ~line 130) destructures ~19 results, the last currently being `configLint`.
Append the three promises to the END of the array (preserving order with the destructure)
and add three matching binding names to the END of the destructure list:
`skillsResult`, `agentsResult`, `commandsResult`. (New names — do NOT reuse `skills`/
`agents`/`commands`, which are already destructured inside the `configLintPromise`
closure.) Awaiting a promise that `configLintPromise` also consumes is safe — promises
memoize; each walk still runs once.

**(c) Hoist the return object and return the pair.** Do NOT retype the ~40-field object.
The final statement is `return {` at ~line 183, a literal whose matching closing `};`
is at ~line 223 (it contains a nested `claude: { … }` block at ~200–207 — make sure you
find the OUTER closing brace, not the inner one). Change `return {` to
`const project: ProjectData = {`, leave the literal body untouched, and immediately after
its closing `};` add:

```ts
  const catalogWalk: ProjectCatalogWalk | null = catalogLintEnabled
    ? { skills: skillsResult, agents: agentsResult, commands: commandsResult }
    : null;
  return { project, catalogWalk };
```

**Verify**: `pnpm typecheck`. The ONLY acceptable errors at this point are at the **call
site** in `scanAllProjects` (~`index.ts:301`), where `scanProject`'s result is still used
as a `ProjectData` — those are expected and fixed in Step 3. If you see ANY type error
*inside* `scanProject` itself (a missing field on `project`, an unterminated object, a
bad binding), you mis-hoisted the literal — STOP, re-check that you changed only `return {`
→ `const project: ProjectData = {` and matched the correct closing brace; do not proceed.

### Step 3: Collect the walks in `scanAllProjects` and pass them to `runCatalogLint`

In `scanAllProjects` (`src/lib/scanner/index.ts`), update the batch loop (the only
caller, line ~301) to destructure the new return shape and build a slug→walk map.
Add, before the scan loop that pushes to `rootProjects`, a map declared at the same
scope as `allProjects`:

```ts
const catalogWalkBySlug = new Map<string, ProjectCatalogWalk>();
```

Then in the batch loop:

```ts
      const results = await Promise.all(batch.map((d) => scanProject(d, devRoot, flags, ctx)));
      for (const r of results) {
        if (r) {
          rootProjects.push(r.project);
          seenSlugs.add(r.project.slug);
          if (r.catalogWalk) catalogWalkBySlug.set(r.project.slug, r.catalogWalk);
        }
      }
```

`attachWorktreeOverlays(rootProjects, …)` and `allProjects.push(...rootProjects)` are
unchanged because `rootProjects` is still `ProjectData[]`.

Update the `runCatalogLint` call (line ~335) to pass the map:

```ts
  const catalogLintFindings = await runCatalogLint(allProjects, flags, ctx, catalogWalkBySlug);
```

**Verify**: `pnpm typecheck`. The Step 2 errors at `index.ts:301` should now be GONE.
The only remaining errors should be inside `catalogLint.ts` (the 4th argument /
`ProjectCatalogWalk` not yet in its signature) until Step 4. If `index.ts` still errors,
your call-site destructure in this step is wrong (you should be reading `r.project` /
`r.catalogWalk`, not `r` as a `ProjectData`) — fix it before moving on.

### Step 4: Consume the map in `runCatalogLint` instead of re-walking

In `src/lib/scanner/catalogLint.ts`:

- Add the fourth parameter and import the type. Use `import type` (NOT a value import):
  `index.ts` already imports `runCatalogLint` from `./catalogLint` at runtime, so a
  *value* import back from `./index` would create a real cycle. A **type-only** import is
  erased at compile time, so it doesn't. This repo's `tsconfig.json` has
  `isolatedModules: true`, which *requires* the `type` keyword for type-only imports — so
  `import type` is both correct and enforced here.
  ```ts
  import type { ProjectCatalogWalk } from "./index";
  // ...
  export async function runCatalogLint(
    projects: ProjectData[],
    flags: MinderConfig["featureFlags"],
    ctx: ProvenanceContext,
    catalogWalkBySlug?: Map<string, ProjectCatalogWalk>,
  ): Promise<LintFinding[]> {
  ```
  (If `pnpm typecheck` still reports a cycle even with `import type` — it shouldn't —
  copy the small `ProjectCatalogWalk` interface into `catalogLint.ts` instead and note
  it in your report.)

- Replace the project-scope re-walks with map lookups. For each project, prefer the
  pre-walked entry; fall back to walking only if the map is missing that slug (defensive
  — e.g. a future caller that doesn't pass the map):

  ```ts
    const projectEntryResults = await Promise.all(
      projects.map(async (p) => {
        const pre = catalogWalkBySlug?.get(p.slug);
        if (pre) return { skills: pre.skills, agents: pre.agents };
        const [pSkills, pAgents] = await Promise.all([
          walkProjectSkills(p.path, p.slug, ctx),
          walkProjectAgents(p.path, p.slug, ctx),
        ]);
        return { skills: pSkills, agents: pAgents };
      })
    );

    const projectCommandSets = await Promise.all(
      projects.map((p) => {
        const pre = catalogWalkBySlug?.get(p.slug);
        return pre ? Promise.resolve(pre.commands) : walkProjectCommands(p.path, p.slug, ctx);
      })
    );
    const [userCommands, pluginCommands] = await Promise.all([
      walkUserCommands(ctx),
      walkPluginCommands(ctx.installedPlugins, ctx),
    ]);
    const allCommands = [userCommands, pluginCommands, ...projectCommandSets].flat();
  ```

  Keep `loadCatalog`, `getUserConfig`, `runGlobalLint`, and the `catch { return []; }`
  exactly as they are.

**Verify**: `pnpm typecheck` → exit 0. `pnpm lint` → exit 0.

### Step 5: Add the regression cases to the existing catalog-lint test

There is **already** a `tests/scannerCatalogLint.test.ts` that imports `runCatalogLint`
directly and mocks exactly the surface you need — `@/lib/indexer/catalog` (`loadCatalog`),
`@/lib/indexer/walkAgents`/`walkSkills`/`walkCommands` (incl. `walkUserCommands`/
`walkPluginCommands`/`walkProjectCommands`), and `@/lib/userConfigCache` (`getUserConfig`)
— plus `makeSkill(...)` / `makeAgent(...)` factory helpers and an `EMPTY_CTX`. **Extend
that file; do not create a new one** and do not re-mock from scratch (its `beforeEach`
already gives `getUserConfig` a correctly-shaped resolve — `userCfg?.plugins.plugins` is
read in `catalogLint.ts:65`, so the mock must NOT be a bare `{}`; reuse what's there).

Add two `it(...)` cases:

1. **Map provided → no project re-walk.** Build
   `const walk = new Map([["a", { skills: [makeSkill()], agents: [makeAgent()], commands: [] }]])`.
   Call `await runCatalogLint([{ slug: "a", path: "/x/a" } as unknown as ProjectData], flags, EMPTY_CTX, walk)`
   with `flags` enabling `configLint` (copy the flags object the existing cases use). Assert
   `walkProjectSkills`, `walkProjectAgents`, `walkProjectCommands` were each called
   **0 times** (`expect(vi.mocked(walkProjectSkills)).not.toHaveBeenCalled()`), while
   `walkUserCommands` / `walkPluginCommands` WERE called (those aren't redundant).
2. **Map omitted → fallback re-walk.** Call the same without the 4th arg (or `undefined`);
   set the three `walkProject*` mocks to resolve `[]`; assert they WERE each called once
   (back-compat preserved).

**Verify**: `pnpm test -- scannerCatalogLint` → all cases in the file pass, including the
two new ones and the pre-existing ones (the latter prove the new optional 4th param didn't
break the 3-arg signature).

### Step 6: Full verification

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → all pass (no previously-green test
regressed); `pnpm lint` → exit 0.

## Test plan

- Extend `tests/scannerCatalogLint.test.ts` (already mocks the full `runCatalogLint`
  surface and has `makeSkill`/`makeAgent`/`EMPTY_CTX`), two new cases:
  1. map provided → `walkProjectSkills`/`walkProjectAgents`/`walkProjectCommands` called 0×;
     `walkUserCommands`/`walkPluginCommands` still called.
  2. map omitted → the three project walkers called once each (back-compat preserved).
- The file's pre-existing cases double as the regression guard that the new optional 4th
  parameter didn't break the 3-arg signature — they must stay green.
- `tests/walkProjectCommands.test.ts` and any other scanner test must remain green.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; the two reuse cases in `tests/scannerCatalogLint.test.ts` pass, and its pre-existing cases stay green
- [ ] `pnpm lint` exits 0
- [ ] `runCatalogLint` no longer calls `walkProjectSkills`/`walkProjectAgents`/`walkProjectCommands`
      for a project present in the passed map (asserted by the new test)
- [ ] `ProjectData` in `src/lib/types.ts` is unchanged (`git diff src/lib/types.ts` empty)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts don't match the live code (drift since `1b45d2b`).
- `scanProject` turns out to have more than one caller (re-run `grep -rn "scanProject(" src/`).
  This plan assumes the single caller at `index.ts:301`.
- Importing `ProjectCatalogWalk` from `./index` into `catalogLint.ts` causes a circular
  *runtime* import (not just a type complaint). If so, duplicate the interface locally and report it.
- `runConfigLint`'s parameter object does not accept `skills`/`agents`/`commands` exactly
  as shown — inspect its real signature and report the mismatch rather than guessing.
- A previously-green test starts failing in a way you can't attribute to your change.

## Maintenance notes

- If a future caller invokes `runCatalogLint` without the walk map (e.g. a standalone
  lint command), the defensive fallback re-walks — correct but slower. Pass the map
  wherever a fresh scan already produced it.
- If `scanProject` ever gains a second caller, that caller must also handle the new
  `{ project, catalogWalk }` return shape.
- Reviewer should confirm `ProjectData` did not grow new fields (the whole point was to
  keep the API payload unchanged) and that the `configLint`-off path still walks nothing.
- Follow-up deliberately deferred: caching the walk across scans (TTL) — out of scope; this
  plan only removes the intra-scan duplication.
