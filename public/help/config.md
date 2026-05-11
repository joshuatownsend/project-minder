# Configuration

The Config page (`/config`) is the single entry point for portfolio-wide configuration. It has six tabs:

| Tab | What it shows |
|-----|---------------|
| **Settings** | Project Minder's own settings (scan roots, batch size, dashboard defaults, hidden projects) |
| **Hooks** | Every Claude Code hook configured in `.claude/settings.json` / `.claude/settings.local.json` across all projects, plus user-level hooks |
| **Plugins** | All Claude Code plugins installed via `~/.claude/plugins/installed_plugins.json` with their enabled / disabled / blocked status |
| **MCP** | Every MCP server configured in any project's `.mcp.json` plus user-level servers from `~/.claude/settings.json` |
| **CI / CD** | Every project that has a `.github/workflows/*.yml`, Vercel/Railway/Fly/Render/Netlify/Heroku/Docker hosting config, or Dependabot updates |
| **Keys** | All top-level keys from your `~/.claude/settings.json` that don't have a dedicated tab (i.e. excludes `hooks`, `mcpServers`, `enabledPlugins`). Use this to copy settings like `statusLine`, `permissions`, or custom keys to any project. |

The CI/CD tab parses workflows down to the **per-job** level: triggers, schedule crons, runs-on, and the deduped list of action `uses:` references for each job. It deliberately does **not** parse step `run:` scripts — those tend to be project-specific noise. Each row retains its source file path, which Template Mode uses to copy units verbatim across projects.

User-level data (plugins, user-level hooks/MCP) lives only on `/config`. Per-project pages show only project-local config — see the [Project Config tab](#project-config-tab) below.

## Template Mode — copy a unit to another project

Rows on the **Hooks**, **MCP**, **Plugins**, and **Keys** tabs all have a `↗ copy to project` action. Clicking it opens a small popover that:

- Lets you pick a target project from your scanned dev roots (the source project is excluded for project-scoped units; all projects are available for user-scope units).
- Shows conflict-policy radios — `skip`, `overwrite`, `merge`, or `rename` (varies by unit type).
- Renders an inline diff via **Preview** before you commit.
- Writes atomically when you click **Apply**, with cache invalidation so the dashboard reflects the change immediately.

Behavior worth knowing:

- **Hooks** — identity is `event + matcher + sha256(invocation)`, so re-applying the same hook is idempotent (no duplicates). Local-scope hooks (`settings.local.json`) are auto-promoted to project-shared (`settings.json`) at the target with a warning. User-scope hooks from `~/.claude/settings.json` also carry a promotion warning — copying to a project makes the hook shared with everyone using that repo. Referenced scripts under `.claude/hooks/<file>` are copied alongside; absolute paths into the source project are rejected.
- **MCP servers** — env *values* are never copied. The target's `.mcp.json` receives empty-string placeholders for every env key, with a warning listing what you need to fill in. User-scope MCP rows get the same promotion warning.
- **Plugins** — the apply button appears on enabled plugins only. It writes the enable flag (`enabledPlugins[key] = true`) to the target's `.claude/settings.json`. If the plugin isn't installed at `~/.claude/plugins/`, the flag is still written and a warning appears with the install command. Conflict policy is `skip` or `merge` (rename is not meaningful for enable-flags).
- **Keys** — copies the value at the selected dotted path into the target's `.claude/settings.json` using deep-merge semantics. `permissions.allow` / `ask` / `deny` arrays concat-and-dedupe; other arrays replace by default; objects deep-merge. Carries a user→project promotion warning.
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

## Screenshot → React Playground

The **Playground** tab on `/config` (`/config?type=playground`) converts a UI screenshot into a single self-contained React TSX component using a vision model. Drop a PNG / JPEG / WebP screenshot, pick a provider + model, and click **Convert**.

| Provider | Default model | Env var (resolved server-side) |
|----------|---------------|-------------------------------|
| Gemini   | `gemini-2.5-flash` | `GOOGLE_API_KEY` |
| OpenAI   | `gpt-4o`           | `OPENAI_API_KEY` |
| Anthropic | `claude-sonnet-4-5` | `ANTHROPIC_API_KEY` |

API keys are **never** stored in `.minder.json` — only the env-var name is configurable. The server reads the secret from `process.env` per request. If the env var is missing the API returns a 412 with the variable name in the error message.

### Code / Preview tabs

After a successful conversion, the output appears with two view tabs:

- **Code** — the raw TSX with a one-click copy button.
- **Preview** — a live render of the generated component inside a sandboxed iframe.

The preview iframe loads Babel (TSX compilation), Tailwind v4 (utility-class JIT), and React 18 UMD from CDN. The iframe uses `sandbox="allow-scripts"` without `allow-same-origin`, which gives it an opaque origin: it cannot read the host's cookies, localStorage, or DOM. Compile errors and runtime exceptions surface as a red banner under the preview frame; the same message is also rendered inside the iframe so you can see it without leaving the preview.

Notes on the preview:

- React 18 (not React 19) is loaded inside the iframe because React 19 dropped its UMD build. Visual rendering is unchanged for utility-class previews.
- The renderer strips ES-module `import` lines before compiling — it exposes `React` and common hooks (`useState`, `useEffect`, `forwardRef`, `memo`, etc.) on the iframe's `window`. Imports of other packages in the generated code will throw at runtime.
- The preview is a screenshot-driven approximation — the playground is intended for rapid prototyping, not production rendering. Copy the code into your real app for the final pass.
