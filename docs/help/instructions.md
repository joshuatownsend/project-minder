# Instructions

The Instructions page is a read-only catalog of **harness-native instruction artifacts** — the standing-prompt and rules files a coding agent loads on its own, distinct from Claude agents and skills. It surfaces Codex's `rules` files, `AGENTS.md`, and `prompts`, plus Gemini's `GEMINI.md` context file, alongside their size and projected context cost.

## What Is a Harness Instruction?

A harness instruction is a plain-Markdown (or text) file that a non-Claude coding agent reads to shape its behavior — closer to a system prompt or a `CLAUDE.md` than to a named agent persona. Unlike a Claude agent or skill, it has no model, no restricted toolset, and no bundled-vs-standalone layout. Because it's a different kind of artifact, it lives in its own catalog rather than mixed into the Agents or Skills browsers.

## Opt-In by Design

The catalog is **opt-in and empty by default.** Project Minder ships with only the Claude harness enabled (`enabledAdapters: ["claude"]`), and Claude's own instructions are surfaced elsewhere — so on a fresh install this page shows an empty state rather than data.

To populate it, enable Codex and/or Gemini under **Settings → Adapters** (`/settings/adapters`). Once an adapter is enabled, Project Minder reads that harness's config home and lists the instruction files it finds. Everything here is **read-only** — Project Minder never edits, moves, or writes these files.

## What It Reads

- **Codex** — instruction files under the Codex config home (`$CODEX_HOME`, default `~/.codex`): `rules/*` files, a top-level `AGENTS.md`, and `prompts/*`.
- **Gemini** — the `GEMINI.md` context file.

If a harness home, directory, or file is missing, it simply contributes nothing — a partial setup never errors.

## Sources

Each entry carries a **source** badge describing its filesystem origin (independent of the owning harness):

- **User** — the harness's user-level config home
- **Plugin** — shipped with an installed plugin
- **Project** — scoped to a specific project

For the harness-native instruction files indexed today, the source is `user` (the harness config home).

## Row Indicators

- **Harness badge** — `Codex`, `Gemini`, or `Claude`, naming the owning tool. This is the distinctive control for this page; the harness filter narrows to one tool.
- **Category badge** — the file's role within its harness (e.g. `rules`, `prompts`, `context`), when known.
- **Source badge** — filesystem origin (see above).
- **`~Nk · X%` chip** — projected context cost of loading this instruction. The token count comes from a `bytes / 4` heuristic on the file size; the percent is against a fixed 200,000-token context window (the Claude Sonnet 4.6 / Opus 4.7 default). Hover for the precise breakdown. Useful for spotting a standing instruction that quietly eats a large slice of every turn's working context. Absent when the file size isn't known or rounds to zero tokens.
- **`!` chip (amber)** — the file's frontmatter has a parse warning (e.g. invalid YAML). Hover to see the message; the row still renders with whatever could be recovered.

## Cross-Project Browser (`/instructions`)

- **Search** — filters by name, description, category, harness, and plugin name
- **Harness filter** — narrow to Codex / Gemini / Claude
- **Source filter** — narrow to user / plugin / project
- **Sort** — by name A–Z, most recently modified, or largest
- **Expand row** — shows the file path, key frontmatter values, and the body excerpt

## How It's Served

The page reads `GET /api/instructions`, which accepts `?harness=`, `?source=`, and `?q=` filters and returns the catalog (a 5-minute cache backs the underlying walk). With the default configuration the endpoint returns an empty list; enabling an adapter is what makes entries appear.
