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

## Engine

Config Lint uses a three-pass engine:

1. **Adapter pass** — re-emits CLAUDE.md audit findings without re-running the audit.
2. **Library pass** — runs the `claude-code-lint` CLI subprocess per project and maps its findings.
3. **Vendored pass** — runs cross-scope rules that require Project Minder's aggregated view (e.g., MCP name collisions across six sources).

The **Engine errors** section at the bottom of the panel appears when any pass fails to run. Engine errors do not suppress findings from the other passes — a broken library pass still shows vendored and adapter findings.

## Feature flag

Config Lint is gated behind the **`configLint` feature flag** (default off) in `/settings`. Enable it to start seeing findings on the next rescan. The tab only appears on projects that have at least one finding.
