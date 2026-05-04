# CLAUDE.md health audit & context budget

The **Context** tab on each project detail page surfaces two diagnostic views of how Claude Code experiences your project:

1. **CLAUDE.md health audit** — a 0–100 score that flags structural problems with your project's `CLAUDE.md` and `.claude/rules/` ecosystem.
2. **Context overhead estimate** — a token-cost breakdown of what Claude loads before reading any of your code.

## Health score

The score starts at 100 and accumulates penalties for each issue Project Minder detects:

| Penalty | Trigger |
|---------|---------|
| `(100 − visibility%) × 0.5` | CLAUDE.md exceeds 200 lines (Claude Code silently truncates the rest). |
| −10 | CLAUDE.md is larger than 25 KB on disk. |
| −3 to −15 | Sections (`#`-headed) with more than 5 content lines (inline bloat). |
| −10 | Index file >50 lines, no `@import` directives, no sibling `.md` files. |
| −5 to −20 | `.claude/rules/` total exceeds 2 000 lines. |
| −2 to −10 | Rules files named like reference/guide/template/api/schema docs (>50 lines) that should be on-demand, not always-loaded. |

Findings are grouped **P0 → P1 → P2** so the most impactful issues land at the top. Each finding includes a one-line fix suggestion.

A color-coded badge appears on the project card whenever the score drops below 80:

- **Green** ≥ 80 — healthy
- **Blue** 60–79 — minor issues
- **Amber** 40–59 — needs attention
- **Red** < 40 — significant rework recommended

## How `@import` is counted

`CLAUDE.md` health uses the **expanded** content of your context (recursively resolving `@import ./path.md` directives up to depth 5, with circular-import detection and HTML comment stripping) — not just the bytes of the index file. A 50-line `CLAUDE.md` that imports five 200-line rules files is scored as if it were one 1 050-line file, because that's what Claude Code actually loads.

## Context overhead estimate

The **Context overhead** panel adds up the tokens Claude Code consumes before it reads any of your project files:

| Component | Estimate |
|-----------|----------|
| System base | 10 400 tokens (fixed Claude Code overhead) |
| MCP servers | 400 tokens × number of servers in scope (project + local + user + plugin + desktop + managed) |
| Skills in scope | 80 tokens × (user + plugin + this-project's project-local skills) |
| Memory files | UTF-8 `byte_count ÷ 4` for `CLAUDE.md` (with imports expanded), user-scope `~/.claude/CLAUDE.md`, and all `.claude/rules/**.md` files |

A USD estimate is computed using the input-token rate from your active pricing model (default: `claude-sonnet-4-5`).

The panel is collapsible and lazy: it only loads when you expand it, so it never slows down the dashboard.

## Limitations

The audit is **structural**, not **semantic** — it can flag a 600-line CLAUDE.md but it can't tell you whether your house rules are accurate. The token estimate is **pre-load only** — it does not include user prompts, tool results, or anything Claude reads during the session.
