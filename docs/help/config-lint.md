# Config Lint

The **Config Lint** tab on each project detail page runs a workspace-wide audit across the ten surfaces that Claude Code reads at the start of every session. Unlike the CLAUDE.md health audit (which focuses on the single file and its import chain), Config Lint covers the full configuration ecosystem.

## Surfaces audited

| Surface | What gets checked |
|---|---|
| **CLAUDE.md** | Re-surfaces findings from the CLAUDE.md health audit in the unified view. No new rules duplicated. |
| **Skills** | Frontmatter completeness (`name`, `description`, `when_to_use`), body length, dangling `@import` references. |
| **Agents** | Frontmatter validity, model/tool-allowlist consistency, description quality. |
| **Commands** | Frontmatter, name collisions across scopes, allowed-tools vs. command body. |
| **Settings** | Deprecated keys, conflicting overrides across project/user/enterprise scopes. |
| **Hooks** | Commands missing a `timeout`, duplicate event handlers with the same source + event + matcher. |
| **MCP Servers** | Servers with the same name registered across multiple sources (project, user, local, plugin, desktop, managed) — a cross-scope collision the library CLI cannot see. |
| **Plugins** | Plugins that are enabled but blocked; enabled plugins without a version pin or git SHA. |
| **Output Styles** | Frontmatter validity for `.claude/output-styles/` style definitions. |
| **LSP Config** | Validity of `.claude/lsp.json` language-server definitions. |

## Severity levels

Findings use the same P0/P1/P2 scale as the CLAUDE.md health audit:

- **P0** — breaks or significantly degrades Claude Code behavior.
- **P1** — likely to cause problems; should be addressed before the next session.
- **P2** — maintenance issues that degrade quality over time.

## Strict gate

The panel header shows a **STRICT: PASS / FAIL** badge. The gate **fails** whenever the project has at least one P0 or P1 finding, and **passes** when only P2 (or zero) findings remain. This is the single authoritative "does this config clear the bar" signal — a CI badge or `?tab=config-lint` deep link reads the same flag rather than re-counting findings. P2-only configurations still pass the strict gate, since P2s are maintenance-grade rather than blocking.

## Formatter

The **Formatter** control (visible on a project's Config Lint tab) wraps `claudelint format` (markdownlint + prettier; shellcheck is used when installed). It has two steps:

1. **Check formatting** — a non-mutating dry run that lists which Claude files (e.g. `CLAUDE.md`, `.claude/settings.json`) would be rewritten. Safe to run anytime; nothing is changed.
2. **Apply** — appears only when the check found files to format. Each target file is **backed up to Config History before it is rewritten**, so every format is reversible from the [Config History](config-history.md) tab. Apply only ever runs on this explicit click — formatting never happens automatically during a scan.

After Apply, the control reports which files actually changed. Files the formatter left untouched have their redundant backup rolled back automatically. Because the formatter delegates to prettier, JSON-with-comments (JSONC) files keep their comments and trailing commas — there is no lossy parse-and-reserialize.

## Engine

Config Lint uses a three-pass engine:

1. **Adapter pass** — re-emits CLAUDE.md audit findings without re-running the audit.
2. **Library pass** — runs the `claude-code-lint` CLI subprocess per project and maps its findings.
3. **Vendored pass** — runs cross-scope rules that require Project Minder's aggregated view (e.g., MCP name collisions across six sources).

The **Engine errors** section at the bottom of the panel appears when any pass fails to run. Engine errors do not suppress findings from the other passes — a broken library pass still shows vendored and adapter findings.

## Browser badges

Every entry in the `/agents`, `/skills`, `/commands`, and `/plugins` browsers shows a small count chip when it has lint findings. The chip is tinted by the highest-severity finding in that entry:

- **Red** — at least one P0 finding
- **Amber** — at least one P1 finding (no P0)
- **Muted** — P2 findings only

For project-scope entries, the chip is a link that navigates directly to the project's Config Lint tab. You can also deep-link there from a URL: `/project/<slug>?tab=config-lint`.

## Portfolio stats

The `/stats` page includes a **Config Lint** section when findings exist. It shows total P0/P1/P2 counts, the number of projects affected, and a bar chart of findings broken down by target surface. The section is hidden when there are no findings (clean workspace or flag off).

## Global catalog pass

In addition to per-project linting, a single **global catalog pass** runs once per scan and covers:

- **Structural rules on user + plugin scope entries** — skills, agents, and commands that live outside any project are checked for missing/long descriptions. (Project-scope entries are handled by the per-project pass to avoid duplication.)
- **Cross-scope duplicate detection** — any two entries (regardless of scope) with the same name emit a `skill/duplicate-name`, `agent/duplicate-name`, or `command/duplicate-slug` finding.

Global-pass findings appear in the browser badges but do not have an associated project, so their chips render without a link.

## Cross-harness drift

> **Where to find it:** Settings → Adapters, not this panel. Drift is a property of your machine's harness config homes rather than of any one project, so it lives beside the adapter toggles that decide which harnesses get compared.

When you run more than one coding harness — Claude Code plus Codex and/or Gemini CLI — their configurations tend to diverge quietly. A skill you install for Claude isn't there next time you reach for Codex; an MCP server gets upgraded in one place and not the other. Config Lint surfaces those gaps under the **Cross-harness Drift** target.

**Minder never writes harness config.** This is the deliberate inversion of tools like ai-devkit, which reconcile `CLAUDE.md` / `AGENTS.md` / `.cursor/rules` / MCP config by generating them from one source of truth. The filesystem is the source of truth here and the index is derived from it; becoming a config writer would break that invariant. Drift is *reported*, and you decide what to do about it.

### What's compared

| Kind | Claude Code | Codex | Gemini CLI |
|---|---|---|---|
| **MCP servers** | `mcpServers` in `~/.claude.json` / `settings.json` (user + managed scope) | `[mcp_servers.*]` in `config.toml` | `mcpServers` in `settings.json` |
| **Skills** | `~/.claude/skills/` | `<CODEX_HOME>/skills/` | `<GEMINI_HOME>/skills/` |
| **Instructions** | `CLAUDE.md` + `rules/` | `AGENTS.md` + `rules/` | `GEMINI.md` |

Root instruction files are compared as **one artifact under three names**. `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` play the same role, so matching them by filename would report each as permanently missing from the other two harnesses. Rules files match on basename, so `context7.md` and `context7.rules` are the same rule.

Symlinked entries are followed. On a machine where skills are stow-linked into a shared directory, a naive listing would drop every link — and an entry missing from an *inventory* gets reported as missing from that *harness*, which would tell you to install something you already have.

### What's reported

Two shapes, deliberately different in granularity:

- **Gaps are summarized.** One finding per (kind, harness → harness), naming a count and up to five examples: *"25 skills configured for Claude Code but not Codex."* A finding per missing item would produce dozens of rows and bury everything else. The overflow count is always stated, so a five-name sample never reads as the whole list.
- **Conflicts are per-item.** When both harnesses have an entry under the same name but define it differently — an MCP server pointed at a different command or URL — each gets its own finding, because one side is probably stale and each is individually actionable. Skills and instructions carry no fingerprint (comparing bodies would mean reading every file on every scan), so they never raise conflicts.

### Severity

Every drift finding is **P2**. Two harnesses configured differently is frequently deliberate, and `hasBlocking` — the strict-lint gate — is any P0 or P1. Enabling a second adapter should not be able to fail your CI on a parity observation.

### Where it appears

**Settings → Adapters.** Findings are grouped by kind (MCP servers, skills, instruction files), each naming a count, a sample, and the target harness's config home. A **Re-check** button re-reads the homes on demand — there is no cached scan behind it.

### When it runs

Drift detection is silent unless a second harness is **enabled** in Settings (`enabledAdapters`) *and* its config home actually exists. The default is Claude only, so a single-harness user sees nothing and pays no filesystem cost — the pass returns before inventorying anything.

Gated behind the **`configDrift` feature flag** (default **on**).

## Feature flag

Config Lint is gated behind the **`configLint` feature flag** (default **on**, opt-out) in `/settings`. Toggle it off to suppress all findings and hide the Config Lint tab. Changes take effect on the next rescan. The Config Lint tab only appears on projects that have at least one finding.
