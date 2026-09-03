# Project Groups

A **project group** is one repository checked out in more than one scanned location — a Windows clone and a WSL clone, or two clones on different drives. Minder groups them automatically by their git remote and gives the group its own page at `/group/<slug>`.

A project with a single checkout is never a group. Nothing about its card or detail page changes.

## How grouping works

- Two scanned projects belong to the same group when their `origin` remotes normalize to the same `host/owner/repo`. Forks (different remotes) do not group; worktrees are not locations (they already attach to their parent project).
- Groups are recomputed on every scan and every manual rescan, and the MCP `scan-projects` tool exposes them too.
- **Opt out** of grouping a checkout by adding its path to `ungroupedPaths` in `.minder.json`. The opt-out is keyed on the path, not the slug, because slugs can be reassigned when scan roots are reordered.
- The group's slug is the repo name. `/group/bamcli` and `/project/bamcli` are different pages about related things: the group, and one of its checkouts. That collision is intended.

## On the dashboard

Each member card carries a **`N loc`** chip next to the worktree chip. Click it to open the group page. Member cards otherwise render exactly as before — they keep their own pins, live-session status, and dev-server controls, which is why the dashboard does not collapse members into a single group card.

## The group page

### Header

The group name, the normalized remote, a **`N locations`** chip, and two attention chips when they apply:

- **partial** — a location's scan root was skipped this pass (a stopped WSL distro, say), so its values are carried forward from an earlier scan. Sums on this page are not authoritative while it shows.
- **N divergences** — repo-borne files disagree between locations. See the Overview tab.

### Overview

- **Locations strip** — one panel per checkout: path (links to the member's own page), branch, dirty count, worktrees, last activity, session count, status, and a dev-server start/stop control. The **PRIMARY** location is the one with the most recent activity; wherever the page shows a single "headline" value for something that differs between copies, it is the primary's copy.
- **Activity** — sessions summed across locations, last session and last activity (the most recent across members), open TODOs and pending manual steps after deduplication.
- **Repo facts** — framework, framework version, and the CLAUDE.md summary, with per-location chips when the copies disagree.
- **Divergences** — one line per file per kind: *no content in* (some locations have nothing parsed for that file) or *differs in* (the copies disagree).

### TODOs, Insights, Board, Manual Steps, Ops

The merged, deduplicated view of each repo-borne file. Identical items across checkouts appear once. Every item carries **divergence chips** where the copies disagree:

| Chip | Meaning |
|---|---|
| `only in C:` / `not in WSL Ubuntu` | The item exists in some locations but not others. |
| `done in C:` | Checked off in some locations, still open in others. |
| `C:: doing` `WSL Ubuntu: done` | A board item whose status differs per location. |
| `edited in D:` | Same item (same id) but a different title, detail, priority, or content. |

Location labels are the shortest path prefix that tells the members apart: a drive letter or WSL distro when that is enough, the parent directory when two members share a drive.

These tabs are read-only. Toggling a step or moving an issue has no single correct target when the copies differ, so edits happen on the member's own page — every location links there.

### Costs

The summed cost is the headline; the **By location** breakdown is directly under it. Rows are per *usage key*, not per location: two local drives that share a usage slug are one key, and the row names every location it covers. Chips:

- **approximate** (and a `~` on the row) — an unpinned usage key spans every configured Claude home for its slug, so a non-member checkout with the same path layout under another home would be included. Pinned (WSL-mapped) keys are exact.
- **partial scan** — see the header chip above; usage is still counted from the index.
- **incomplete** — a usage query failed; the sum covers only the keys that answered.

The cache-hit rate is pooled from the summed tokens, never averaged across locations. Rates without summable parts (one-shot, self-correction) are not shown at group level.

### Sessions

Session counts per location from the scan, then each location's own session list. Hidden in demo mode and when no member has sessions.

### Environments

What differs per *machine* rather than per checkout: user agents, skills (including disabled ones), installed plugins with versions, and MCP server names, compared across the Claude homes the group's locations live under. A WSL-mapped location joins to its distro's home; an unmapped one joins to this machine's `~/.claude`.

- Rows that differ sort first and carry a **differs** chip; a `✓` means present, `—` means absent, and a value in the cell (a version, `disabled`) is the detail that differs.
- Homes that could not be read this cycle are listed with the reason rather than hidden — Minder never wakes a stopped WSL distro to read it.
- When every location shares one home there is nothing to diff; the tab shows that home's inventory.

Only server *names* are read from MCP configs — never their commands or environment blocks.

Repo-borne `.claude/` agents and skills are the same files in every checkout and are not compared here; a checkout on a different branch would show up as a divergence on the file tabs.

## Demo mode

The demo portfolio includes two checkouts of `aurora-commerce`, so the group chip and page can be explored without a real multi-location setup. The Sessions and Environments tabs are hidden in demo mode because the fixtures have no sessions or Claude homes behind them.
