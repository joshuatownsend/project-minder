# Skills

The Skills page catalogs all Claude Code skills available to you — from your personal `~/.claude/skills/` directory, installed plugins, and per-project skill definitions — alongside invocation statistics.

## What Is a Skill?

A skill is a reusable prompt template invoked via the `Skill` tool inside Claude Code sessions. Skills live as Markdown files with YAML frontmatter and can be user-invocable (triggered via `/skillname` slash commands) or invoked programmatically.

## File Layouts

Two layouts are supported:

- **Bundled** — a directory named after the skill containing `SKILL.md` (e.g., `~/.claude/skills/audit/SKILL.md`)
- **Standalone** — a plain `.md` file directly in the skills root

## Sources

- **User** — skills in `~/.claude/skills/`
- **Plugin** — skills from installed plugins (e.g., `vercel:nextjs`, `clerk-setup`)
- **Project** — skills in `<project>/.claude/skills/`

## Cross-Project Browser (`/skills`)

- **Search** — filters by name, description, and plugin name
- **Source filter** — narrow to user / plugin / project skills
- **Sort** — by most invoked, recently used, or name A–Z
- **Row chips** — version badge, slash-command hint (for user-invocable skills), `standalone` layout indicator
- **Expand row** — shows body excerpt, recent sessions, and a "View full body" toggle

## Per-Project Skills Tab

On each project's detail page, the **Skills** tab shows:

- **Available (project-local)** — skills in the project's `.claude/skills/` folder
- **Invoked here** — skills used in this project's session history, sorted by invocation count

## Usage Statistics

Invocation counts come from the `Skill` tool call's `skill` argument in session history. Plugin-namespaced invocations (e.g., `vercel:deploy`) are matched against the catalog by the `pluginname:slug` alias key. Unmatched names appear as **Plugin (uncategorized)** rows.
