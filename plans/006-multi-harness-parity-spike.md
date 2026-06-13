# Plan 006: Multi-harness adapter parity — investigation & gap analysis (spike)

> **Executor instructions**: This is an **investigation/spike** plan. Its deliverable is a
> written gap-analysis document plus a prioritized list of follow-up work — **not** a code
> change. Do NOT implement parity fixes here; surface them. Follow the steps, and STOP-and-
> report if a foundational assumption turns out false. When done, update the status row in
> `plans/README.md` unless a reviewer told you they maintain it.
>
> **Drift check (run first)**: `git diff --stat 1b45d2b..HEAD -- src/lib/adapters src/lib/db src/lib/usage/aggregator.ts`
> Recent churn in these areas is expected; just read the current code, don't assume.

## Status

- **Priority**: P3
- **Effort**: M (investigation)
- **Risk**: LOW (produces a document; no behavior change)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `1b45d2b`, 2026-06-13

## Why this matters

Project Minder already has a multi-harness adapter registry: `src/lib/adapters/index.ts`
registers **claude**, **codex**, and **gemini** adapters behind a `SessionAdapter` interface,
and `discoverAllSessions(config)` fans out across the user's `enabledAdapters`. So the
common assumption "this is Claude-only and a second harness needs building from scratch" is
**false** — discovery and per-file parsing scaffolding exist for three harnesses. The open
question — and the genuine adjacent-possible — is **how complete** non-Claude support is
across all the surfaces that matter: SQLite ingest, usage cost/aggregation, session detail,
agents/skills catalogs, and OTEL. Before anyone invests in "more Codex/Gemini support," we
need an honest map of what already works end-to-end vs. what silently degrades to
Claude-only. This spike produces that map and a prioritized follow-up list, so the next
build decision is grounded rather than guessed.

## Current state (entry points to investigate)

- `src/lib/adapters/types.ts` — the contract. `SessionAdapter` has: `id`, `displayName`,
  `discover(): Promise<SessionFile[]>`, `parseFile(file): Promise<UsageTurn[]>`, optional
  `parseFileWithMeta?(file)` (returns `{ turns, meta: SessionTurnsMeta }`), optional
  `readConfig?()` (Codex implements it; Claude/Gemini leave it undefined). **Note**:
  `parseFileWithMeta` and `readConfig` are *optional* — a key parity axis is which adapters
  implement which optionals.
- `src/lib/adapters/index.ts` — registry, `getEnabledAdapters(config)` (defaults to
  `["claude"]` when `enabledAdapters` unset), `discoverAllSessions(config)`.
- `src/lib/adapters/claude.ts`, `codex.ts` (537 lines), `gemini.ts` — the three implementations.
- `src/lib/db/ingest.ts` (2,377 lines) + `src/lib/db/ingestWatcher.ts` — does ingest consume
  `discoverAllSessions` output (all harnesses), or does it read Claude `~/.claude/projects`
  JSONL directly? This determines whether non-Claude sessions reach the SQLite index at all.
- `src/lib/usage/aggregator.ts` — imports `getAdapterDisplayNameMap` and produces a
  `SourceBreakdown` (line ~27 in its type imports), implying source-aware aggregation. Trace
  whether `generateUsageReport`/`aggregateUsage` actually pull multi-harness turns (via
  `discoverAllSessions` / each adapter's `parseFile`) or only Claude.
- `src/lib/data/*FromDb.ts` — the DB-backed read modules (session detail, sessions list,
  usage, agents, skills). If only Claude sessions are ingested, these are Claude-only by
  construction even if the UI is source-agnostic.
- README documents Gemini session reading (`~/.gemini/tmp/...`) and the Codex read-only
  config surface — useful ground truth for expected behavior.

## Method (use CodeGraph first)

This project has CodeGraph initialized (`.codegraph/` exists). Use `codegraph_explore` as
the primary tool to trace each flow in one call (e.g. explore `discoverAllSessions parseFile
ingest generateUsageReport` together to surface the path). Fall back to Grep/Read only for
gaps. Trace these flows and record, for **each of claude / codex / gemini**, whether the
surface is Full / Partial / Absent:

1. **Discovery** — does `<adapter>.discover()` find real session files? (config keys,
   default paths, `enabledAdapters` gating.)
2. **Per-file parse** — `parseFile` implemented? `parseFileWithMeta` implemented?
   (`parseFileWithMeta` powers session-detail/meta surfaces.)
3. **SQLite ingest** — do this adapter's sessions get written to `~/.minder/index.db`
   (via the ingest pipeline), or is ingest hardwired to Claude's JSONL layout?
4. **Usage/cost aggregation** — do its turns appear in `generateUsageReport`/`SourceBreakdown`,
   and does `costCalculator` price its models?
5. **Session detail / list UI** — do `data/sessionDetailFromDb` / `sessionsListFromDb` surface
   non-Claude sessions, or filter to Claude?
6. **Agents / skills / commands catalogs** — Claude-specific or harness-aware?
7. **OTEL telemetry** — Claude-only (`CLAUDE_CODE_ENABLE_TELEMETRY`) or generalizable?

## Deliverable

Create `docs/adapters/multi-harness-parity.md` (create the `docs/adapters/` dir if needed)
containing:

- A **parity matrix**: rows = the 7 surfaces above; columns = claude / codex / gemini; each
  cell = Full / Partial / Absent + a one-line evidence pointer (`file:line`).
- For each Partial/Absent cell that matters, a 2–4 sentence note: what's missing, the
  blast radius (which files a fix would touch), and a coarse effort estimate (S/M/L) — and
  say the estimates are coarse.
- A **prioritized follow-up list** (top 3–5): the highest-value parity gaps to close, each
  framed as a candidate future plan (title + one-line scope). Do NOT write those plans here.
- An **open-questions** section: anything you couldn't determine from the code (e.g. whether
  Codex session cost data is even available to compute, format instability risks).

Optionally, append a short "Multi-harness parity (backlog)" section to `plans/README.md`
listing the candidate follow-ups by title so they're tracked — but do not number them as
real plans until selected.

## Commands you will need

| Purpose   | Command                          | Expected |
|-----------|----------------------------------|----------|
| Typecheck | `pnpm typecheck`                 | exit 0 (you changed no source — sanity only) |
| Tests     | `pnpm test`                      | all pass (unchanged) |

(No new tests — this is investigation. The verification is that the document is accurate and
every claim cites `file:line`.)

## Scope

**In scope** (create):
- `docs/adapters/multi-harness-parity.md`
- (optional) a backlog section appended to `plans/README.md`.

**Out of scope** (do NOT touch):
- Any file under `src/` — this spike changes **no** behavior. If you find a one-line obvious
  bug while reading, note it in the document's open-questions section; do not fix it here.
- Do not implement any adapter, ingest, or aggregation change.

## Git workflow

- Branch: `advisor/006-multi-harness-parity-spike`.
- Commit style: Conventional Commits (e.g. `docs(adapters): multi-harness parity gap analysis`).
- Do NOT push or open a PR unless instructed.

## Done criteria

ALL must hold:

- [ ] `docs/adapters/multi-harness-parity.md` exists with the 7×3 parity matrix, each
      non-trivial cell backed by a `file:line` evidence pointer
- [ ] A prioritized follow-up list of 3–5 candidate plans (titles + one-line scopes) is present
- [ ] An open-questions section is present
- [ ] No files under `src/` were modified (`git status` shows only the doc, and optionally `plans/README.md`)
- [ ] `pnpm typecheck` and `pnpm test` still pass (proves you changed no source)
- [ ] `plans/README.md` status row for plan 006 updated

## STOP conditions

Stop and report back if:

- It turns out ingest/aggregation is genuinely multi-harness-complete already (all cells
  Full) — then the deliverable is "parity is complete; here's the evidence," and there is no
  follow-up list. That's a valid, valuable outcome — report it.
- The adapter registry has changed shape since `1b45d2b` such that the entry points above no
  longer exist — re-orient from `src/lib/adapters/index.ts` and note the new structure.
- You cannot determine a surface's behavior from the code within a reasonable read budget —
  record it as an open question rather than guessing a cell value.

## Maintenance notes

- This document will drift as adapters evolve; date it and treat it as a point-in-time map.
- The follow-up list feeds a future `/improve` planning pass — keep each candidate scoped
  small enough to become one plan.
- If the matrix reveals that ingest is Claude-hardwired, the highest-leverage follow-up is
  likely "route `discoverAllSessions` output through the ingest pipeline" — but confirm with
  evidence before asserting it.
