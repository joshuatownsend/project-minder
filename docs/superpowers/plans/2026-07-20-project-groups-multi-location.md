# Project Groups — one project, many locations

Status table at the bottom is the source of truth.

## The problem

The same repository is often checked out in more than one place: `C:\dev\bamcli` on Windows
and `\\wsl.localhost\Ubuntu-26.04\home\josh\printing-press\library\bamcli` inside WSL. These
are two working copies of one project — the user edits and runs Claude in both — but Minder
treats them as two unrelated projects, or (until #324) silently showed only one.

The goal is **not** to fuse them. Each location is a distinct working environment with its own
branch, its own dirty files, its own dev server, and — critically — its own *Claude
configuration*: skills, agents, plugins, and MCP servers installed in that machine's Claude
home. The user wants each location drillable on its own, **and** a single place that answers
"what is this project costing me / what have I learned about it" across all of them.

So: aggregate some things, diff others, and never merge a third set.

## Attribution check (2026-07-20) — a prerequisite is broken

Before designing aggregation, we verified whether WSL session data is attributed correctly
today. **It is not**, and the gap is large enough to invalidate any sum built on top of it.

For `bamcli`:

| Location | Session dir | Sessions | Size |
|---|---|---|---|
| Windows | `~/.claude/projects/C--dev-bamcli` | 1 | 3.9 MB |
| WSL (printing-press) | `~/.claude/projects/-home-josh-printing-press-library-bamcli` | 5 | 79 MB |
| WSL (dev) | `~/.claude/projects/-home-josh-dev-bamcli` | 3 | 36 MB |

**97% of this project's session data is invisible to Minder.** Two independent causes, both
configuration rather than code:

1. **`claudeHomes` is empty**, so `getClaudeHomes()` (`src/lib/claudeHome.ts:40`) returns only
   the Windows `~/.claude`. The WSL Claude home is never read at all — those 8 sessions are not
   mis-joined, they are never loaded.
2. **`pathMappings` is empty**, so `mapLocalPath()` (`src/lib/pathMapping.ts:58`) is the
   identity function. Even with the home loaded, the scanner's UNC path would never match a
   session dir encoded from the Linux path `/home/josh/printing-press/library/bamcli`.

The code supports both settings correctly — `PATCH /api/config` validates and persists
`claudeHomes` and `pathMappings` (`src/app/api/config/route.ts:62-85`), and `/api/wsl` already
*returns suggested values* for them. The break is in the UI: `ScanRootsSection.save()`
(`src/components/settings/ScanRootsSection.tsx:64`) sends only `{ devRoots: roots }`. It fetches
`claudeHomes` into state and drops it; `pathMappings` is not even in its `WslDistroSuggestion`
type. **Detect WSL therefore produces a half-configured setup**: projects scan, and everything
that joins them to Claude data silently returns nothing.

This is P0. Aggregation across locations is meaningless while one location contributes zero.

## The core distinction: four kinds of data, four merge rules

Getting this taxonomy right is most of the design. The failure mode of a naive
"union everything" implementation is that it double-counts committed files (every insight
appears twice) while under-counting activity (WSL costs missing entirely).

| Kind | What it is | Rule | Why |
|---|---|---|---|
| **Repo-borne** | Committed files: `INSIGHTS.md`, `TODO.md`, `BOARD.md`, `CLAUDE.md`, `OPERATIONS.md`, `MANUAL_STEPS.md`, project-level `.claude/` skills+agents | **Deduplicate**, and surface divergence | Both checkouts hold the *same file*. Summing double-counts. |
| **Activity** | Usage/costs, sessions, tool calls, one-shot rate | **Sum / union** | Genuinely different work done in different places. |
| **Location-bound** | Branch, dirty files, ahead/behind, dev server + port, worktrees | **Never merge** | A merged "branch" is a lie when the two checkouts differ. |
| **Environment-borne** | User- and plugin-level skills, agents, commands, MCP servers, hooks — per *Claude home*, not per repo | **Diff** | The user explicitly wants to see what exists on one machine and not the other. |

### Repo-borne: dedupe, and treat divergence as signal

`INSIGHTS.md` entries carry stable IDs (`<!-- insight:9dc5a394e11e | session:… -->`) and
`BOARD.md` issues carry `^i-` IDs — both dedupe exactly. `TODO.md` items have no IDs and need
content hashing, which is approximate.

Where two checkouts' copies of a repo-borne file *differ*, that is information, not an error:
it means one checkout is stale, or they are on different branches. The UI should say
"`TODO.md` differs between locations" rather than silently picking one. `MANUAL_STEPS.md` is
the sharpest case — the same checklist with different boxes ticked is exactly what a user needs
to see.

### Activity: sum, but recompute derived metrics

Costs and token counts add. Derived *rates* must be recomputed over the union, never averaged:
averaging two one-shot rates weights a 3-session location equally with a 100-session one. Any
metric shaped `numerator/denominator` aggregates by summing both, then dividing.

### Environment-borne: the comparison view

This is the surface with no equivalent today. The indexer already tags catalog entries
`user | plugin | project` (`GET /api/agents?source=`), which maps cleanly onto the split:
`project`-source entries are repo-borne (dedupe), `user` and `plugin` sources are
environment-borne (diff). The natural presentation is a two-column comparison per Claude home:
present in both / only here / only there.

## Identity model

**Group key = normalized git remote.** `parseGitHubRemote` (`src/lib/githubRemote.ts`) already
extracts `owner/repo`; normalize ssh vs https and strip `.git` to canonical
`github.com/<owner>/<repo>`. Projects with no remote group alone, keyed by path.

- A group's slug is the **base slug** — `bamcli`. Members keep their scan slugs (`bamcli`,
  `bamcli-library`), which #324 already made unique and stable. The collision suffix doubles as
  the location discriminator, which is why #324 is a prerequisite rather than a coincidence.
- **A group of one is today's behavior**, byte for byte. No UI change for single-location
  projects; this feature must be invisible to the ~45 projects that have one checkout.
- **Forks won't auto-group** (different remotes). Accepted for v1; manual linking covers it.
- **Worktrees are not locations.** They already have their own overlay mechanism and share a
  remote — the grouping pass must exclude anything already attached as a `WorktreeOverlay`, or
  every worktree becomes a phantom location.
- **Auto-group with an opt-out.** `.minder.json` gains an unlink list for users who want two
  checkouts kept genuinely separate.

## UI shape

- **Dashboard**: one card per group with a `2 locations` chip; card body shows aggregated cost
  and activity. Single-location projects render exactly as now.
- **Detail page**: group header, plus a **Locations** strip showing each checkout's path,
  branch, dirty count, and dev-server state side by side — the "drill into each root path"
  requirement.
- **Tabs**: Insights/TODOs/Board render deduped with divergence flags. Costs and Sessions
  aggregate with a per-location breakdown. A new **Environments** tab holds the skills/agents/
  MCP comparison.
- Every aggregate view needs a visible per-location split. The sum is the headline; the
  breakdown is one click away, never hidden.

## Phases

**P0 — Fix attribution (prerequisite, standalone PR).** Persist `claudeHomes` and
`pathMappings` from Detect WSL. Add both to the suggestion type, apply them in `save()`, and
surface them in Settings as editable lists so a manually-added WSL root can be completed by
hand. Verify against the numbers above: `bamcli` should go from 1 session to 9. Tests for the
apply path; this is a real bug independent of grouping and should ship first.

**P1 — Identity and grouping.** Remote normalization + `deriveProjectGroups()` as a pure
function over scanned `ProjectData[]`, excluding worktree overlays. Config opt-out. No UI yet —
groups computed and exposed on the API only, so the grouping can be validated against real data
before anything renders.

**P2 — Aggregation layer.** A pure `aggregateGroup(members)` implementing the four rules, with
the derived-metric recomputation. Heavily unit-tested — this is where double-counting bugs live.

**P3 — UI.** Group cards, Locations strip, divergence flags, Environments comparison tab.

## Risks and open questions

| # | Risk | Mitigation |
|---|---|---|
| 1 | **P0 is a config-shape change users must re-run.** Existing WSL users have half-configured setups and won't know it. | Detect the state (WSL root present, no matching mapping/home) and prompt in Settings. |
| 2 | Averaging derived rates across locations silently produces wrong numbers | Aggregate numerator+denominator, never the rate. Assert in tests. |
| 3 | `TODO.md` dedupe is content-hash based and approximate — reworded items appear twice | Accept; show divergence rather than claiming a clean merge. |
| 4 | Worktrees share a remote and would become phantom locations | Exclude overlay-attached dirs in P1; test explicitly. |
| 5 | Group slug `bamcli` collides with the member slug `bamcli` in routing | Decide the URL space in P1 before any UI: separate `/group/` namespace, or groups own the base slug and members move under it. |
| 6 | Reading a second Claude home means reading a WSL path | Must honor the existing never-wake rule — `getReadableClaudeHomes()` already does; P0 must not bypass it. P0 only writes config, so nothing new reads a WSL path. |
| 9 | **Dev and installed builds read different configs.** `resolveStateDir()` is `MINDER_STATE_DIR \|\| process.cwd()`; the tray sets it to `%USERPROFILE%\.minder` (`supervisor.rs:446`), while `pnpm dev` falls back to the repo root. | Config changes made while testing in dev do not affect the installed instance and vice versa. When verifying against real data, confirm which `.minder.json` is in play. |
| 7 | Aggregation over a stopped WSL distro shows a partial sum that looks authoritative | Mark aggregates as partial when a member's location is unreachable; never silently drop a member from a total. |
| 8 | Same repo, different branches → repo-borne files legitimately differ | Divergence is surfaced, not resolved. Do not attempt a merge. |

## Status

| Task | Description | Status |
|---|---|---|
| A0 | Attribution check — quantify the join gap | DONE (2026-07-20) — 97% of `bamcli` sessions invisible; two config causes identified |
| — | Slug collision fix (prerequisite) | DONE — PR #324 |
| P0 | Persist `claudeHomes` + `pathMappings` from Detect WSL; Settings editors | DONE (2026-07-20) — `src/lib/wslCompanions.ts`, derived from the root rather than the suggestion (covers hand-typed roots); repair banner for existing setups; 31 tests incl. an end-to-end resolve to the real session dir. **Deviation:** free-form editors for `claudeHomes`/`pathMappings` were *not* built — derivation covers every case reachable from a scan root, and the repair path handles pre-existing setups. Hand-editing is still possible in `.minder.json`. Revisit if a non-derivable mapping (bind mount, renamed home, non-WSL cross-machine) is ever needed. |
| P1 | Remote normalization, `deriveProjectGroups()`, config opt-out, API exposure | DONE (2026-07-21) — `src/lib/groups/{types,identity,derive}.ts`, `ungroupedPaths` in `.minder.json`, `ScanResult.groups`; 19 tests. **URL space decided (Risk #5): separate `/group/<slug>` namespace** — every existing `/project/<slug>` keeps its current meaning, and a group/project slug collision is intended rather than a defect. **Risk #4 was a non-issue:** worktree dirs never become `ProjectData` at all — a worktree's `.git` is a file, and `isGitRepo` requires a directory, so they are filtered before slug assignment; a test pins the consequence. **Deviation:** the opt-out is keyed on checkout PATH, not slug, because `resolveProjectSlug` reassigns slugs when `devRoots` is reordered and a slug-keyed list would silently re-merge a split pair. **Blocker found and fixed:** validating against real data showed every UNC/WSL project had `git: undefined` (git's `safe.directory` ownership check, silently swallowed by `runGit`), so the feature's own driver could not group — fixed with a scoped `-c safe.directory=*` on Minder's read-only git calls. Verified end-to-end: `bamcli` and `micetrocli` now group Windows↔WSL. |
| P2 | `aggregateGroup()` — four merge rules, derived-metric recomputation | NOT STARTED |
| P3 | UI: group cards, Locations strip, divergence flags, Environments tab | NOT STARTED |
