# Board

The Board gives each project a lightweight, git-tracked task board — epics broken into issues, with status, priority, labels, and provenance — surfaced both per-project and across your whole portfolio.

The board lives in a `BOARD.md` file in each project root. The filesystem stays the source of truth; Minder reads it during the scan and serves it to the UI.

> Reading the board is gated by the **Scan BOARD.md** feature flag (Settings → Features), on by default.

## Where you see it

- **Cross-project page (`/board`)** — every project's board in one place. Search issue text, filter by status, and scope to a single project. Issues are grouped under their epic, with the Inbox shown as its own lane.
- **Per-project Board tab** — appears on a project's detail page once it has a `BOARD.md`. Change an issue's status inline (a dropdown per issue), add a new issue straight to the Inbox, and **promote an issue to a task** (a row action that bridges it into the task dispatcher; once promoted the row shows `→ task #N`).
- **Card badge** — each project card shows a count of open (non-done) issues.

## BOARD.md grammar

The parser is deliberately tolerant of hand edits — missing tokens, extra whitespace, and bare checkbox lines all parse.

```markdown
# Board — my-project
<!-- minder-board: v1 -->

## Epic: Authentication ^e-a1b2  [doing]  !high  @security
> Optional blockquote description for the epic.

- [ ] Wire ClerkProvider ^i-c3d4  [todo]  !med  #frontend
- [>] Add middleware ^i-e5f6  [doing]  #backend
- [x] Spike Clerk ^i-g7h8  [done]
  Optional indented detail line for the issue above.

## Inbox
- [ ] (finding) Hardcoded secret ^i-9k0l  [triage]  @wt:fix-leak  ~session:abc123
```

### Tokens

- **Status glyph** — `[ ]` = to-do, `[>]` = doing, `[x]` = done. If no explicit `[status]` token is present, status is derived from the glyph.
- **`[status]`** — one of `backlog`, `todo`, `doing`, `review`, `done`, `triage`. An explicit token wins over the glyph.
- **`!priority`** — `!high`, `!med`, or `!low`.
- **`#label`** — any number of hashtag labels.
- **`^e-…` / `^i-…`** — stable IDs for epics and issues. These are **random surrogate keys**, not content hashes: they survive title edits and reordering so an issue keeps its identity. Minder backfills missing IDs the first time it writes the file. (They are how a mutation targets the exact line, so don't hand-rewrite them.)
- **`@wt:<branch>` / `~session:<id>`** — provenance: which worktree/branch and Claude Code session an item came from. Shown as small chips. `@wt:` is provenance, not a label.

### Inbox

The `## Inbox` section is the triage lane for items not yet sorted into an epic. Issues that appear before any header also land in the Inbox, so nothing is silently dropped.

## Mutations

The Board tab writes through a serializing writer that edits only the targeted line, preserving the rest of your hand formatting. Supported actions (also available via `POST /api/board/[slug]`): add issue, add epic, set status, edit issue, move between epics/Inbox, reorder, and promote a TODO.

`status` and `priority` values are validated against the supported sets before any write, so a malformed request is rejected rather than corrupting `BOARD.md`.

### TODO → Board promote path

`TODO.md` stays your quick-capture inbox. When a TODO is ready to become tracked work, it can be **promoted** into a board issue: the issue is created from the TODO's text and the source TODO is marked done (idempotently — promoting the same item twice won't reopen it).

### Promote to task

A board issue (any row with a stable `^i-` id) can be **promoted to an executable task** that the task dispatcher runs. Use the "Promote to task" row action on the Board tab, or `POST /api/board/[slug]` with `{ "action": "promoteToTask", "id": "i-…" }`. This creates a `delegated-todo` task in `~/.minder/tasks.db` tagged with board provenance (`sourceType: "board-issue"`, `boardIssueId`, `projectSlug`), and returns `{ taskId, board }`.

The lifecycle is two-way and best-effort: promoting flips the issue to `doing` (in flight), and when the dispatcher finishes the task it flips the same issue to `done`. A missing/edited issue never fails the task — the sync is swallowed.

## Agent write-bridge (MCP)

A running Claude Code session can write to the board over Project Minder's [MCP server](mcp-server) — no HTTP loopback, the tools call the same writer the UI does. Four tools are exposed:

- **`board_create_issue`** — add an issue under an epic (`epicId`) or the Inbox, with optional `status`/`priority`/`labels` and `sessionId`/`worktree` provenance.
- **`board_log_finding`** — record an agent-discovered finding as a `(finding) …` Inbox row at status `triage`, so you can triage it later.
- **`board_postpone`** — snooze an issue by setting its status (defaults to `backlog`).
- **`board_promote_to_task`** — bridge an issue into the task dispatcher (same path as the UI action above), returning `{ taskId, board }`.

All four resolve the project by `slug`, write the canonical main-tree `BOARD.md`, and return the re-parsed board. Out-of-enum values are rejected at the JSON-RPC boundary; an unknown slug or stale issue id comes back as an error result.

## The done lane: BOARD.archive.md

Like `TODO.md` / `MANUAL_STEPS.md`, the board follows the living-checklist convention. Move finished epics/issues into a companion `BOARD.archive.md` to keep the active board — and its counts — focused on outstanding work. The scanner ignores `*.archive.md`, and the per-project board view can read the archive on demand (`?archived=1`).

## Worktrees: planning is canonical to the main tree

Planning files are **project-scoped, not branch-scoped**. If you (or an agent) work inside a git worktree, board writes are redirected to the canonical main-tree `BOARD.md` rather than a per-branch copy, so planning never fragments across worktrees and never causes merge conflicts. Items keep their `@wt:`/`~session:` provenance so you can still see where they came from.
