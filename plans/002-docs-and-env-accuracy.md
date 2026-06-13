# Plan 002: Correct the stale "No database" docs and add `.env.example`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1b45d2b..HEAD -- CLAUDE.md README.md`
> If either file changed since this plan was written, re-read the relevant
> section and compare against the excerpts below before editing.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs / dx
- **Planned at**: commit `1b45d2b`, 2026-06-13

## Why this matters

`CLAUDE.md` (the file every Claude/agent session loads for orientation) states under
**Stack**: "**No database** — filesystem is the database; user prefs in `.minder.json`".
That is now actively false: the project has a substantial SQLite layer — `src/lib/db/`
(ingest, migrations, FTS5, maintenance), `src/lib/data/*FromDb.ts` query modules, and a
`~/.minder/index.db` index documented in `README.md`. Actively-wrong orientation docs are
worse than missing ones: they send agents and contributors down the wrong mental model.
Separately, the repo documents four runtime env vars in `README.md` but ships no
`.env.example`, so there's no template to copy and typos surface only at runtime. Both are
~10-minute, zero-risk fixes that improve every future session's accuracy.

## Current state

### `CLAUDE.md` — Stack section (the false claim)

The Stack bullet list contains exactly this line (verbatim):

```
- **No database** — filesystem is the database; user prefs in `.minder.json`
```

Later, the **Architecture** section lists scanner / process-manager / usage modules but
has **no** "Database" subsection, even though `src/lib/db/` and `src/lib/data/` are large
subsystems. (The "Known Limitations / Technical Debt" section says "None currently
tracked".)

### The DB layer actually exists

- `src/lib/db/connection.ts` — opens `~/.minder/index.db` via `better-sqlite3` (an
  **optional** dependency; `require` is wrapped in try/catch with a `loadError` fallback).
- `src/lib/db/ingest.ts`, `migrations.ts`, `maintenance.ts`, `otelQueries.ts`.
- `src/lib/data/*FromDb.ts` — `usageFromDb`, `sessionDetailFromDb`, `sessionsListFromDb`,
  `claudeUsageFromDb`, `agentsUsageFromDb`, `skillsUsageFromDb`, etc.
- FTS5 (`prompts_fts`) full-text search over session prompts.
- Backend selection via `MINDER_USE_DB` (default on; `=0` forces direct-JSONL file parsing).

### `README.md` documents the env vars but there's no template

`README.md` (around lines 229–236) has this table (verbatim values):

```
| `MINDER_USE_DB` | on | `=0` disables the SQLite index (session pages fall back to direct JSONL parsing). |
| `MINDER_INDEXER` | on | `=0` suppresses the chokidar watcher (no automatic index updates). |
| `MINDER_INDEXER_WORKER` | off | `=1` hosts the watcher in a `worker_thread` for crash isolation. |
| `GEMINI_HOME` | `~/.gemini` | Override the Gemini CLI data directory. |
```

Read sites (confirmed): `MINDER_USE_DB` at `src/lib/data/gradeSnapshots.ts:70` (and
elsewhere); `MINDER_INDEXER` at `src/lib/db/ingestWatcher.ts:138`; `GEMINI_HOME` at
`src/lib/adapters/gemini.ts:212`. `MINDER_INDEXER_WORKER` is read in the indexer worker
bootstrap. There is **no** `.env.example` file (confirmed: `ls .env.example` → not found).

### Convention to follow

`.env.local` is gitignored (per README "Set in `.env.local` (gitignored)…"). `.env.example`
is the standard committed template. Keep the example values as **defaults / illustrative
only** — never real secrets (there are none for this tool; all four vars are behavior toggles/paths).

## Commands you will need

| Purpose          | Command                          | Expected on success         |
|------------------|----------------------------------|-----------------------------|
| Confirm no file  | `ls .env.example`                | "No such file" before; lists it after |
| Build (docs-safe)| `pnpm build`                     | exit 0 (sanity; no code changed) |
| Grep check       | `grep -n "No database" CLAUDE.md`| no matches after Step 1     |

(No typecheck/test needed — this plan changes only Markdown and adds a dotfile. Run
`pnpm build` once at the end purely as a smoke check that nothing was accidentally broken.)

## Scope

**In scope** (the only files you should modify/create):
- `CLAUDE.md` — fix the false line; add a short Database subsection.
- `.env.example` — create.
- `README.md` — add one line pointing at `.env.example` (optional but recommended; see Step 3).

**Out of scope** (do NOT touch):
- Any file under `src/`, `tests/`, `docs/help/` — no code or behavior changes here.
- `.gitignore` — `.env.example` is meant to be committed; do not add it to ignore.
- The `MEMORY.md` auto-memory file under the user's home — not part of this repo's docs.
- Do NOT "fix" other parts of `CLAUDE.md` you happen to disagree with — only the database claim.

## Git workflow

- Branch: `advisor/002-docs-env-accuracy`.
- Commit style: Conventional Commits (e.g. `docs: correct stale no-database claim; add .env.example`).
- Per repo policy, `CLAUDE.md` is committed (not stashed). Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Fix the false claim in `CLAUDE.md`

Replace the Stack bullet:

```
- **No database** — filesystem is the database; user prefs in `.minder.json`
```

with:

```
- **SQLite index** (`better-sqlite3`, optional dep) at `~/.minder/index.db` — the
  filesystem remains the source of truth; the DB is a derived, rebuildable index.
  User prefs live in `.minder.json`. Set `MINDER_USE_DB=0` to disable the DB and fall
  back to direct JSONL parsing.
```

**Verify**: `grep -n "No database" CLAUDE.md` → no matches.

### Step 2: Add a short Database subsection to `CLAUDE.md` Architecture

Under the **Architecture** heading (after the existing module subsections, before
"Known Limitations / Technical Debt"), add:

```markdown
### Database (`src/lib/db/`, `src/lib/data/`)
- SQLite index at `~/.minder/index.db` via `better-sqlite3` (optional dependency;
  `connection.ts` wraps the `require` in try/catch and degrades gracefully if absent).
- `ingest.ts` writes sessions/turns/tool-uses; `migrations.ts` versions the schema;
  `maintenance.ts` handles pruning/vacuum; `otelQueries.ts` serves OTEL telemetry reads.
- FTS5 (`prompts_fts`) backs session prompt search.
- `src/lib/data/*FromDb.ts` are the DB-backed query modules; routes should obtain init
  status via `probeInitStatus()` from `@/lib/data` rather than calling `initDb()` directly.
- Backend selection: `MINDER_USE_DB` (default on; `=0` forces the direct-JSONL path).
```

**Verify**: visual — the subsection renders as a sibling of the other `### …` Architecture
subsections.

### Step 3: Create `.env.example`

Create `.env.example` at the repo root with the four documented vars, their defaults
commented, and a header explaining it's a template:

```dotenv
# Project Minder — local runtime overrides.
# Copy to .env.local (gitignored) and uncomment any you want to change.
# All four are behavior toggles / paths — there are no secrets in this file.

# Disable the SQLite index; session pages fall back to direct JSONL parsing.
# Default: on. Set to 0 to disable.
# MINDER_USE_DB=0

# Suppress the chokidar watcher (no automatic index updates).
# Default: on. Set to 0 to disable.
# MINDER_INDEXER=0

# Host the indexer watcher in a worker_thread for crash isolation.
# Default: off. Set to 1 to enable.
# MINDER_INDEXER_WORKER=1

# Override the Gemini CLI data directory (default: ~/.gemini).
# GEMINI_HOME=
```

Then add one line to `README.md` near the env-var table (immediately above or below it):

```
Copy `.env.example` to `.env.local` and uncomment what you need.
```

**Verify**: `ls .env.example` → the file is listed.

### Step 4: Smoke check

**Verify**: `pnpm build` → exit 0 (confirms no Markdown edit accidentally touched a code path;
this is just a safety net).

## Test plan

No automated tests — Markdown + dotfile only (per `CLAUDE.md` testing policy, docs are not
unit-tested). Verification is the `grep` and `ls` checks above plus a clean `pnpm build`.

## Done criteria

ALL must hold:

- [ ] `grep -n "No database" CLAUDE.md` returns no matches
- [ ] `CLAUDE.md` has a `### Database` subsection under Architecture
- [ ] `.env.example` exists at repo root with all four vars (`MINDER_USE_DB`, `MINDER_INDEXER`, `MINDER_INDEXER_WORKER`, `GEMINI_HOME`)
- [ ] `.env.example` is NOT gitignored (`git check-ignore .env.example` prints nothing)
- [ ] `README.md` references `.env.example`
- [ ] `pnpm build` exits 0
- [ ] No files under `src/` or `tests/` modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The exact line `- **No database** — filesystem is the database; user prefs in \`.minder.json\``
  is not present in `CLAUDE.md` (it may have already been fixed — if so, only do Steps 2–4 and note it).
- `.env.example` already exists (don't overwrite blindly — report its contents and stop).
- The README env-var table values differ from the excerpt above (the source of truth is the
  live README; reflect the real defaults in `.env.example` and note the discrepancy).

## Maintenance notes

- When a new `MINDER_*` env var is added in code, add it to both the README table and
  `.env.example` in the same PR.
- Reviewer should confirm `.env.example` contains no real secrets (it shouldn't — these
  are all toggles/paths) and that the `CLAUDE.md` Database subsection matches the actual
  `src/lib/db/` module layout at review time.
- The `connection.ts` graceful-degradation detail is worth keeping accurate — if the DB
  ever becomes a hard dependency, update both the Stack bullet and the subsection.
