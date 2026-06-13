# Plan 003: Guard non-array assistant `content` in the usage parser

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1b45d2b..HEAD -- src/lib/usage/parser.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpts below against the live code before editing; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1b45d2b`, 2026-06-13

## Why this matters

`parseSessionTurns` and `parseSessionTurnsWithMeta` (in `src/lib/usage/parser.ts`) read
an assistant turn's `message.content`, then call `(content as any[]).filter(...)` and
`extractText(content)` **without checking that `content` is an array**. If `content` is a
string, `.filter` throws `TypeError: content.filter is not a function`, which aborts the
*entire* file parse — that session silently fails to ingest/report. The tell that this is a
real latent bug, not a theoretical one: the **same function** already guards
`Array.isArray(content)` 26 lines later (line 401, for thinking-block extraction), so the
author knows non-array content is reachable here — the guard was just applied
inconsistently. Normalizing `content` to an array once, at the top of each branch, fixes
the crash for `.filter`, `extractText`, and the thinking loop uniformly.

## Current state

`src/lib/usage/parser.ts` has two near-identical assistant-turn branches:

- `parseSessionTurns` — exported async, **line 119**; assistant branch around lines 180–234.
- `parseSessionTurnsWithMeta` — exported async, **line 280**; assistant branch around lines 360–419.

Both read content the same way and filter it unguarded:

```ts
// parseSessionTurns, line ~190
const content = entry.message?.content ?? [];
// ...
const toolCalls = (content as any[])          // ← line ~193: crashes if content is a string
  .filter((b: any) => b.type === "tool_use")
  .map((b: any) => { /* ... */ });
const assistantText = extractText(content) || undefined;  // ← line ~214: extractText takes any[]
```

```ts
// parseSessionTurnsWithMeta, line ~370
const content = entry.message?.content ?? [];
// ...
const toolCalls = (content as any[])          // ← line ~375: same crash
  .filter((b: any) => b.type === "tool_use")
  .map((b: any) => { /* ... */ });
const assistantText = extractText(content) || undefined;  // ← line ~397
const isError = entry.isApiErrorMessage === true;
// Check for thinking blocks.
if (!hasThinking && Array.isArray(content)) {  // ← line ~401: ALREADY guards Array.isArray
  for (const b of content as any[]) {
    if (b?.type === "thinking") { hasThinking = true; break; }
  }
}
```

`extractText` is array-typed and will also misbehave on a string:

```ts
// line 43
function extractText(content: any[]): string {
  return extractTextRaw(content).slice(0, 500);
}
```

### Why a string is reachable

These are Claude-format JSONL parsers; assistant `content` is normally an array of blocks.
A string arrives from malformed/truncated lines or future format variance — and the
existing `Array.isArray` guard at line 401 confirms the author already treats it as
possible. The **user-turn** branch (lines ~235–239) already handles mixed string/array
content with its own fallback logic — **do not change the user branch**; only the two
assistant branches lack the guard.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                 | exit 0              |
| Tests     | `pnpm test -- usageParser`       | all pass incl. new case |
| Full test | `pnpm test`                      | all pass            |
| Lint      | `pnpm lint`                      | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/lib/usage/parser.ts` — the two assistant-branch `content` normalizations only.
- `tests/usageParser.test.ts` — add a regression case.

**Out of scope** (do NOT touch):
- The **user-turn** branch (`entry.message?.content` / `entry.content` fallback ~lines 235–239)
  — it already handles mixed shapes.
- `extractText` / `extractTextRaw` / `extractToolResults` signatures — leave as-is; the
  normalization at the call site is sufficient.
- Any other parser logic, the `parseSessionTurnsWithMeta` thinking-block guard at line 401
  (it becomes redundant after normalization, but leave it — removing it is unrelated churn).

## Git workflow

- Branch: `advisor/003-parser-content-guard`.
- Commit style: Conventional Commits (e.g. `fix(usage): guard non-array assistant content in parser`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Normalize `content` in `parseSessionTurns`

In `parseSessionTurns` (line 119), in the `if (type === "assistant")` branch, replace:

```ts
const content = entry.message?.content ?? [];
```

with:

```ts
const rawContent = entry.message?.content;
const content = Array.isArray(rawContent) ? rawContent : [];
```

Leave the `(content as any[]).filter(...)` and `extractText(content)` lines unchanged —
`content` is now guaranteed to be an array.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Normalize `content` in `parseSessionTurnsWithMeta`

In `parseSessionTurnsWithMeta` (line 280), in its `if (type === "assistant")` branch, make
the identical replacement of `const content = entry.message?.content ?? [];` with the
`rawContent` + `Array.isArray` form from Step 1.

**Verify**: `pnpm typecheck` → exit 0; `pnpm lint` → exit 0.

### Step 3: Add a regression test

In `tests/usageParser.test.ts`, find the existing `describe`/`it` block that exercises
`parseSessionTurns` against a temp JSONL file (the file already builds fixtures with
`fs`/`os`/`path` and imports `parseSessionTurns`). Add one test that:

1. Writes a temp JSONL file containing a valid assistant entry whose `message.content` is a
   **plain string** (not an array) — copy the shape of an existing assistant-line fixture in
   that test file and change only `content` to e.g. `"plain string body"`.
2. Calls `await parseSessionTurns(tempPath, dirName)` (use the same dirName/arg convention
   the surrounding tests use).
3. Asserts it does **not** throw, returns one assistant turn, that turn's `toolCalls` is an
   empty array, and `assistantText` is the string (or its 500-char slice).

If you cannot locate an existing assistant fixture to copy, STOP and report — do not invent
a JSONL shape from scratch (required fields like `timestamp`/`sessionId`/`message.model`
matter and the existing tests are the source of truth).

**Verify**: `pnpm test -- usageParser` → all pass including the new case. To prove the test
catches the bug, you may temporarily revert Step 1 and confirm the new test fails with
`content.filter is not a function`, then re-apply Step 1 (do not commit the revert).

### Step 4: Full verification

**Verify**: `pnpm test` → all pass; `pnpm typecheck` → exit 0; `pnpm lint` → exit 0.

## Test plan

- New case in `tests/usageParser.test.ts`: assistant turn with string `content` parses
  without throwing, yields empty `toolCalls` and the string as `assistantText`.
- Structural pattern: the existing `parseSessionTurns` temp-file tests in the same file.
- All existing parser tests stay green.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; new string-content case in `tests/usageParser.test.ts` passes
- [ ] `pnpm lint` exits 0
- [ ] Both assistant branches in `parser.ts` normalize `content` via `Array.isArray`
      (`grep -n "Array.isArray(rawContent)" src/lib/usage/parser.ts` → 2 matches)
- [ ] The user-turn branch is unchanged
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The "Current state" excerpts don't match the live code (drift since `1b45d2b`).
- `parseSessionTurns` no longer takes a file path as its first argument (the test harness
  assumption is wrong — inspect the real signature and report).
- You can't find an existing assistant-turn fixture in `tests/usageParser.test.ts` to model on.

## Maintenance notes

- The thinking-block `Array.isArray(content)` guard at line ~401 is now redundant; a future
  cleanup could drop it, but it's harmless — note it for the reviewer rather than removing
  it here.
- If non-Claude harness sessions are ever routed through `parseSessionTurns` (they currently
  go through their own adapter `parseFile`), revisit content-shape assumptions across the
  whole function.
- Reviewer should confirm the normalization is at the top of each assistant branch (so it
  protects `.filter`, `extractText`, AND the thinking loop), not just wrapped around `.filter`.
