# Skills

The Skills page catalogs all Claude Code skills available to you — from your personal `~/.claude/skills/` directory, installed plugins, and per-project skill definitions — alongside invocation statistics and origin provenance.

## What Is a Skill?

A skill is a reusable prompt template invoked via the `Skill` tool inside Claude Code sessions. Skills live as Markdown files with YAML frontmatter and can be user-invocable (triggered via `/skillname` slash commands) or invoked programmatically.

## File Layouts

Two layouts are supported:

- **Bundled** — a directory named after the skill containing `SKILL.md` (e.g., `~/.claude/skills/audit/SKILL.md`)
- **Standalone** — a plain `.md` file directly in the skills root

## Sources

- **User** — skills in `~/.claude/skills/` (including symlinks to `~/.agents/skills/`)
- **Plugin** — skills from installed marketplace plugins (e.g., `vercel:nextjs`)
- **Project** — skills in `<project>/.claude/skills/`

## Provenance Badges

Each row shows a colored badge indicating where the skill came from:

- **Marketplace badge** (e.g. `claude-plugins-official`) — skill is part of an installed plugin from that marketplace. Shows plugin version and commit SHA in the expanded view.
- **GitHub repo badge** (e.g. `owner/repo`) — skill was installed via `npx claude-skills install` and is tracked in `~/.agents/.skill-lock.json`. Shows install date and folder hash.
- **"local"** — user-authored skill with no upstream.
- **"project: slug"** — skill defined in a project's `.claude/skills/` directory.

## Update Detection

Project Minder checks each skill for available updates in the background:

- **Marketplace plugins** — compares the installed commit SHA against the latest `HEAD` of the marketplace repository via `git ls-remote`. One network call per marketplace (shared across all plugins from that marketplace).
- **Lockfile skills** — compares the installed `skillFolderHash` against the current tree SHA for that directory on GitHub (via the GitHub API). Set `GITHUB_TOKEN` in your environment for higher rate limits (unauthenticated is 60 req/h, sufficient at the 24-hour cache TTL).
- **User-local / project-local** — never checked (no upstream to compare against).

An **amber dot** on the provenance badge indicates an update is available. The expanded row shows `update: <currentRef> → <upstreamRef>` with short 7-character hashes.

## Cross-Project Browser (`/skills`)

- **Search** — filters by name, description, and plugin name
- **Source filter** — narrow to user / plugin / project skills
- **Updates filter** — show only skills with detected updates; `…` appears while the background check is still running
- **Sort** — by most invoked, recently used, or name A–Z
- **Row chips** — version badge, slash-command hint (for user-invocable skills), `standalone` layout indicator
- **Expand row** — shows provenance details, action buttons, body excerpt, and recent sessions

## Per-Row Actions (Expanded View)

Click any row to expand it and reveal:

- **Open source ↗** — opens the skill's GitHub repository in a new browser tab
- **Show in folder** — opens Explorer/Finder at the skill's install directory
- **Copy url** — copies the source URL to the clipboard
- **Copy sha** — copies the commit SHA or folder hash to the clipboard
- **Copy path** — copies the install path to the clipboard
- **Re-check** — clears the update cache and re-queues all skills for a fresh check
- **↗ copy to project** — Template Mode action: copies this skill into another project's `.claude/skills/` folder. Bundled skills copy as a directory tree (preserving companion files); standalone skills copy as a single `.md`. Pick a target, choose a conflict policy (`skip` / `overwrite` / `rename`), preview the diff, and apply. Plugin-source skills don't show this action. See the [Config help page](/help/config) for full Template Mode behavior.

## Per-Project Skills Tab

On each project's detail page, the **Skills** tab shows:

- **Available (project-local)** — skills in the project's `.claude/skills/` folder
- **Invoked here** — skills used in this project's session history, sorted by invocation count

## Usage Statistics

Invocation counts come from the `Skill` tool call's `skill` argument in session history. Plugin-namespaced invocations (e.g., `vercel:deploy`) are matched against the catalog by the `pluginname:slug` alias key. Unmatched names appear as **Plugin (uncategorized)** rows.
