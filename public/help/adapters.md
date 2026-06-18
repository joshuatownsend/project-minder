# Adapters

Project Minder reads AI coding-agent sessions through **adapters** — thin modules that know how to discover session files and parse them into a common format. This architecture makes it straightforward to support multiple coding assistants from one dashboard.

## Available adapters

| Adapter | ID | Status |
|---|---|---|
| Claude Code | `claude` | Active |
| Codex | `codex` | Active |
| Gemini CLI | `gemini` | Active |

## Codex adapter

The Codex adapter reads sessions from `~/.codex/sessions/` and `~/.codex/archived_sessions/`, walking both recursively. Each session file is a JSONL event stream where the first line is session metadata (including the working directory). Sessions are deduped by their session ID so a file copied to the archive directory is not double-counted.

To enable Codex alongside Claude Code:

```json
{ "enabledAdapters": ["claude", "codex"] }
```

**Custom data location:** If your Codex data is not in `~/.codex/`, set the `CODEX_HOME` environment variable to the directory you want the adapter to scan. This takes precedence over the default `~/.codex/` path and is useful for CI environments or non-standard installs.

Note: Codex does not report cache-creation tokens, so `cacheCreateTokens` will always be 0 for Codex sessions. Cost estimates use OpenAI model pricing when available; a model id with no pricing match is priced as **unknown ($0)** rather than billed at Claude rates (see the pricing note below).

## Gemini CLI adapter

The Gemini CLI adapter reads sessions from `~/.gemini/tmp/<project>/chats/session-*.json`. Each session file is a JSON document containing an array of messages. Project folder paths are resolved from `~/.gemini/projects.json` (which maps folder paths to project names) or from `.project_root` files written by newer Gemini CLI versions that use hashed directory names.

To enable Gemini CLI alongside Claude Code:

```json
{ "enabledAdapters": ["claude", "gemini"] }
```

**Custom data location:** Set the `GEMINI_HOME` environment variable to override the default `~/.gemini/` path.

Note: Gemini CLI does not report cache-creation tokens, so `cacheCreateTokens` will always be 0 for Gemini sessions. Token values are treated as per-turn deltas. Cost estimates use Google model pricing when available.

When Gemini is enabled, the global `GEMINI.md` context file (at `~/.gemini/GEMINI.md`, or the name set via `context.fileName` in `~/.gemini/settings.json`) is surfaced in the harness instruction catalog (`/api/instructions`, `harness=gemini`).

## How non-Claude sessions are indexed

When you enable Codex or Gemini, their sessions are indexed into the same SQLite index Claude Code sessions use, so they appear in the sessions browser and feed the usage analytics. A few things are worth knowing about how this works:

- **Opt-in.** Indexing only happens for adapters listed in `enabledAdapters`. With the default (`["claude"]`), no Codex/Gemini data is read or written — enabling an adapter is what turns its indexing on. Disabling an adapter later removes its sessions from the index on the next scan.
- **Lean index for non-Claude.** Claude Code sessions are parsed from their raw JSONL into the richest possible record. Codex/Gemini sessions are indexed through the adapter's own parser, which yields a slightly leaner record. What you **do** get: per-session and per-turn **cost**, **token** totals, **By Source / By Model / By Project / By Category** breakdowns, **work-mode** mix, **one-shot** rate, **tool usage**, and full **session list + detail** (timeline, tools). What is currently **Claude-only**: full-text prompt search richness, PR/ticket chips, resume-anomaly and compaction-loop flags, and per-turn context-fill.
- **Identity.** Each non-Claude session is keyed by the real session ID the harness records (Codex `session_meta.payload.id`, Gemini `record.sessionId`), not its filename — so sessions correlate correctly and never collide across harnesses.
- **Freshness.** New/changed Codex/Gemini sessions are picked up by the background sweep (about every 30 seconds) rather than instantly, which is the cadence Claude sessions get from the per-file watcher.

> **Pricing note:** cost for a non-Claude model is accurate when live pricing data (LiteLLM, refreshed daily) includes that exact model id — which it normally does for current OpenAI/Google models. A non-Claude id with **no** pricing match (e.g. a brand-new or unlisted model, or while running on the offline fallback) is priced as **unknown ($0)** rather than being silently billed at Claude rates, so a fabricated cost never inflates your totals. If you want a specific rate for such a model, add a **pricing rule** in Settings and it will be applied.

## Managing adapters

Go to **Settings → Adapters** to see which adapters are enabled. Disabling an adapter hides its sessions from the session browser and excludes them from analytics. All adapters, including Claude Code, can be toggled.

## Harness config (read-only)

The **Harnesses** page (under **Review** in the sidebar, route `/adapters`) shows a **read-only** view of an enabled harness's own configuration home. Codex is the first supported harness: it surfaces

- the parsed `config.toml` (model, reasoning effort, sandbox settings, configured MCP servers, enabled plugins, marketplaces) as a structured tree;
- `rules/` instruction files (content shown inline, capped per file);
- presence flags for notable subdirs (`memories`, `plugins`, `automations`, `prompts`).

This is **view-only** — there is no edit, copy, or share affordance, and it never reads credential files (`auth.json`). **Secrets are redacted server-side before the config ever leaves your machine's process**: bearer tokens, API keys, `[mcp_servers.*.env]` values, and `http_headers` are all blanked (the key is still shown so you can see *that* something is configured, just not its value). The config home is resolved the same way as session discovery — `$CODEX_HOME` if set, otherwise `~/.codex`.

A harness appears here only when it both exposes a config surface and is enabled in `enabledAdapters`; if none qualify, the page explains how to enable one. Write/manage, per-harness backups, and security scanning for non-Claude harnesses are intentionally out of scope for this read-only first cut.

## Source badges

A small source badge appears in the session row and session header to indicate which adapter produced the session, making it easy to distinguish sessions at a glance.

## By Source breakdown

The `/usage` page shows a **By Source** section whenever source data is available. This lets you compare cost and usage across different coding assistants.

## API

Several endpoints accept an optional `?source=` query parameter to filter results by adapter (`claude`, `codex`, `gemini`):

- `GET /api/sessions?source=claude` — session list for a specific source
- `GET /api/usage?source=claude` — usage report for a specific source
- `GET /api/adapters` — list all registered adapters
- `GET /api/instructions` — harness-native instruction artifacts (Codex `rules`/`AGENTS.md`/`prompts`), gated by `enabledAdapters`. Here `?harness=` selects the harness (`codex`/`gemini`/`claude`); `?source=` means the catalog **origin** (`user`/`plugin`/`project`), not the adapter; `?q=` is a free-text filter.

## Configuration

`enabledAdapters` in `.minder.json` controls which adapters are active. You can also set this via `PATCH /api/config`:

```json
{ "enabledAdapters": ["claude"] }
```

Unknown adapter IDs in this list are rejected with a 400 error naming the known adapters.
