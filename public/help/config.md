# Configuration

The Config page (`/config`) is the single entry point for portfolio-wide configuration. It has five tabs:

| Tab | What it shows |
|-----|---------------|
| **Settings** | Project Minder's own settings (scan roots, batch size, dashboard defaults, hidden projects) |
| **Hooks** | Every Claude Code hook configured in `.claude/settings.json` / `.claude/settings.local.json` across all projects, plus user-level hooks |
| **Plugins** | All Claude Code plugins installed via `~/.claude/plugins/installed_plugins.json` with their enabled / disabled / blocked status |
| **MCP** | Every MCP server configured in any project's `.mcp.json` plus user-level servers from `~/.claude/settings.json` |
| **CI / CD** | Every project that has a `.github/workflows/*.yml`, Vercel/Railway/Fly/Render/Netlify/Heroku/Docker hosting config, or Dependabot updates |

The CI/CD tab parses workflows down to the **per-job** level: triggers, schedule crons, runs-on, and the deduped list of action `uses:` references for each job. It deliberately does **not** parse step `run:` scripts — those tend to be project-specific noise. Each row retains its source file path, which Template Mode uses to copy units verbatim across projects.

User-level data (plugins, user-level hooks/MCP) lives only on `/config`. Per-project pages show only project-local config — see the [Project Config tab](#project-config-tab) below.

## Template Mode — copy a unit to another project

Each project-scoped row on the **Hooks** and **MCP** tabs has a `↗ copy to project` action. Clicking it opens a small popover that:

- Lets you pick a target project from your scanned dev roots (the source project is excluded).
- Shows conflict-policy radios — `skip`, `overwrite`, `merge`, or `rename` (varies by unit type).
- Renders an inline diff via **Preview** before you commit.
- Writes atomically when you click **Apply**, with cache invalidation so the dashboard reflects the change immediately.

Behavior worth knowing:

- **Hooks** — identity is `event + matcher + sha256(invocation)`, so re-applying the same hook is idempotent (no duplicates). Local-scope hooks (`settings.local.json`) are auto-promoted to project-shared (`settings.json`) at the target with a warning. Referenced scripts under `.claude/hooks/<file>` are copied alongside; absolute paths into the source project are rejected.
- **MCP servers** — env *values* are never copied. The target's `.mcp.json` receives empty-string placeholders for every env key, with a warning listing what you need to fill in.
- **Agents and skills** — the same `↗ copy to project` action lives on rows in `/agents` and `/skills`. Bundled skills (directory + companion files) copy as a tree; standalone `.md` skills and agents copy as single files.

## Project Config tab

When a project has any project-local hooks (`.claude/settings.json`), MCP servers (`.mcp.json`), or CI/CD configuration, a **Config** tab appears on its detail page. The tab has four sections:

- **Hooks** — events (PreToolUse / PostToolUse / etc.), matchers, and command previews; the `settings` / `settings.local` source is shown on the right.
- **MCP Servers** — name, transport (stdio / http / sse), command + args (or URL), and the count of configured env keys (key names only — never values).
- **GitHub Workflows** — file name, top-level workflow name, normalized triggers, cron schedules, and per-job rows with each job's `uses:` action references.
- **Hosting & Automation** — host platform pills (Vercel, Railway, etc.), Vercel cron entries, Dependabot updates with their schedule interval.

A small `CI` badge appears on the dashboard card whenever the project has at least one workflow file.

## Scan Roots

Add one or more directories for Project Minder to scan. For each root, Project Minder checks its immediate child directories for git repositories.

- **Primary root** — the first entry. Used as the base path for dev server security validation and shown in the header.
- **Ordering** — use the up/down arrows to reorder. Move your most-used root to the top.
- **Adding** — type a full path (e.g. `C:\work`) and click Add or press Enter.
- **Removing** — click the trash icon. You must keep at least one root.

> **Slug collisions**: if two roots contain directories with the same name (same slug), the first root wins and the duplicate is skipped.

## Scan Behavior

### Batch size

Controls how many projects are scanned in parallel per root. Default is 10.

- Lower values (3–5) reduce CPU pressure during large scans.
- Higher values (15–30) are faster on machines with many cores.
- Range: 1–50.

## Dashboard Defaults

These settings control the initial state of the project dashboard on each page load. You can still change them per session via the sort/filter controls.

| Setting | Options |
|---------|---------|
| Default sort | Last Activity, Name, Claude Session |
| Default status filter | All, Active, Paused, Archived |

## Hidden Projects

Projects hidden from the dashboard appear here. Directories in this list are skipped during every scan — they won't show up in counts or cards.

To hide a project, use the three-dot menu on its card. To unhide, click **Unhide** next to the project name on this page.

## Saving Changes

Edits to scan roots and scan behavior are not applied until you click **Save Changes**. Hidden project changes (unhide) take effect immediately.

After saving, the next scan will pick up new roots. You can trigger an immediate rescan from the dashboard footer.
