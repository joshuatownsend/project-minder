# Adapters

Project Minder reads AI coding-agent sessions through **adapters** — thin modules that know how to discover session files and parse them into a common format. This architecture makes it straightforward to support multiple coding assistants from one dashboard.

## Available adapters

| Adapter | ID | Status |
|---|---|---|
| Claude Code | `claude` | Active |
| Codex | `codex` | Active |
| Gemini | `gemini` | Coming in Wave 10.2c |

## Codex adapter

The Codex adapter reads sessions from `~/.codex/sessions/` and `~/.codex/archived_sessions/`, walking both recursively. Each session file is a JSONL event stream where the first line is session metadata (including the working directory). Sessions are deduped by their session ID so a file copied to the archive directory is not double-counted.

To enable Codex alongside Claude Code:

```json
{ "enabledAdapters": ["claude", "codex"] }
```

Note: Codex does not report cache-creation tokens, so `cacheCreateTokens` will always be 0 for Codex sessions. Cost estimates use OpenAI model pricing when available, falling back to Claude Sonnet pricing for unknown models.

## Managing adapters

Go to **Settings → Adapters** to see which adapters are enabled. Disabling an adapter hides its sessions from the session browser and excludes them from analytics. All adapters, including Claude Code, can be toggled.

## Source badges

A small source badge appears in the session row and session header to indicate which adapter produced the session, making it easy to distinguish sessions at a glance.

## By Source breakdown

The `/usage` page shows a **By Source** section whenever source data is available. This lets you compare cost and usage across different coding assistants.

## API

The following endpoints accept an optional `?source=` query parameter to filter results by adapter:

- `GET /api/sessions?source=claude` — session list for a specific source
- `GET /api/usage?source=claude` — usage report for a specific source
- `GET /api/adapters` — list all registered adapters

## Configuration

`enabledAdapters` in `.minder.json` controls which adapters are active. You can also set this via `PATCH /api/config`:

```json
{ "enabledAdapters": ["claude"] }
```

Unknown adapter IDs in this list are rejected with a 400 error naming the known adapters.
