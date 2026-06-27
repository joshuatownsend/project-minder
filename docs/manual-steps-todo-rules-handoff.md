# Handoff for project-minder — MANUAL_STEPS.md / TODO.md rules + hooks

Source repo: `C:\dev\patchmaven` (ContinuanceLabs/patchmaven). Captured 2026-06-26.
Purpose: standardize the "manual steps / TODO are living checklists, completed work
gets archived" convention across projects.

---

## 0. TL;DR of what was actually changed in this repo

- **CLAUDE.md** — `## Manual Steps` section reworded from *append-only / never modify*
  to *living checklist; editing & pruning expected*. (1 doc change.)
- **No hook files were modified.** Both validators were only read, not edited.
- **`MANUAL_STEPS.md` content** — 7 pre-existing column-0 descriptive bullets in old
  migration entries were converted to `- [x]` (so the file became editable), then the
  Vercel deployment checklist was appended. (Content only, not a rule/hook change.)
- All committed in PR #170 (commits `a368685`, `8c18db4`) on branch
  `chore/vercel-deploy-phase0`.

---

## 1. CLAUDE.md change (the only rule edit)

Section: `## Manual Steps`.

### Edit A — intro line
- BEFORE: `…deploy trigger — append to ` + "`MANUAL_STEPS.md`:"
- AFTER:  `…deploy trigger — record it in ` + "`MANUAL_STEPS.md`" + `, the living checklist of manual actions the developer still needs to take:`

### Edit B — "Rules:" line replaced with a bulleted block
BEFORE (single line):
> Rules: **append only**, never modify existing entries, one header per session/feature, create the file if it doesn't exist, tell the developer what was logged after appending.

AFTER:
> Rules:
> - **Add** a dated entry (one header per session/feature) for new manual work; create the file if it doesn't exist.
> - **Keep it current.** Once a step is done, or a newer plan/action makes it obsolete, either check it off (`- [x]`) if it's worth keeping as a record or remove it — so the list shows only what's still outstanding. The file is a to-do list, not an append-only log; editing and pruning prior entries is expected.
> - Don't remove a step you can't confirm is done or obsolete — surface the uncertainty to the developer instead.
> - Format (enforced by `.claude/hooks/validate-manual-steps.mjs`): every list item is a `- [ ]` / `- [x]` checkbox, and every dated entry ends with a `---` separator.
> - After changing the file, tell the developer what you added, checked off, or removed.

NOT changed: the `## TODO List` section of CLAUDE.md still says only "append it to
`TODO.md`." For a consistent living-checklist philosophy, TODO needs a parallel edit.

---

## 2. Hooks — UNCHANGED. Current behavior (for cross-project replication)

Both are PreToolUse hooks that fire on the **Write and Edit tools only** (not Bash).
Both key on the **exact filename** → archive files with any other name are exempt.

### `.claude/hooks/validate-manual-steps.mjs`
Acts only when `tool_input.file_path` is `MANUAL_STEPS.md` (or `*/MANUAL_STEPS.md`).
For Edit, it reconstructs the full file (`current.replace(old_string, new_string)`)
and validates EVERY line:
1. Any line matching `^- ` that is not `---` must match `^- \[[ x]\] ` (checkbox).
2. Any header matching `^## \d{4}-\d{2}-\d{2}` must match
   `^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} \| .+ \| .+`  (i.e. `## YYYY-MM-DD HH:MM | slug | title`).
3. Every dated entry must be closed by a `---` line before the next dated header / EOF.
Returns `{decision:'block', reason:…}` listing violations, else `{decision:'approve'}`.
NO append-only / no-deletion enforcement — format only.

### `.claude/hooks/validate-todo-format.mjs`
Acts only when path is `TODO.md`. Validates full reconstructed content; flags any line
matching `^- (?!\[[ x]\] )` (a bare `- ` that is not a checkbox). Indented detail lines,
`#` headings, and blank lines are allowed. Format only.

---

## 3. Implications for an archive design (not yet implemented)

- Name archive files so they DON'T end in `/MANUAL_STEPS.md` or `/TODO.md`
  (e.g. `MANUAL_STEPS.archive.md`, `TODO.archive.md`) → exempt from the validators,
  so archived items can keep `[x]`, `~~strikethrough~~`, or any legacy formatting.
- File shapes differ, which affects how each archives:
  - `MANUAL_STEPS.md` = dated whole-entry blocks (`## YYYY-MM-DD HH:MM | slug | title`
    + why-context + checkbox steps + `---`). Archive by moving the whole block.
  - `TODO.md` = topic sections (`## Topic`) with `**Context:**` blocks and `[x]`
    items interleaved among `[ ]` items. "Done" work is scattered WITHIN live sections,
    not standalone blocks — archive by lifting completed items / whole shipped sections.
- A Bash-tool edit (e.g. `sed`) bypasses the validators if you ever need to fix
  pre-existing violations that no single Edit can resolve (full-file validation + the
  edit being non-contiguous).

---

## 4. Deployment context (so this handoff is self-contained)

This rules discussion arose during the PatchMaven → Vercel deployment work.
Deployment plan: `~/.claude/plans/playful-frolicking-eclipse.md`.
Open work tracked in the session task list (Phases 1–5) and in the
`## 2026-06-26 | vercel-deployment` entry now in `MANUAL_STEPS.md`.
