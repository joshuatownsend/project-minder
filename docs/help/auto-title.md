# Auto-title

Project Minder can generate a concise 4–8 word title for each Claude Code session using an LLM. Generated titles replace the raw first prompt in the sessions list.

## Setup

1. Go to **Settings → Auto-title**.
2. Enter your API key (Anthropic or compatible provider) and click **Save settings**.
3. Click **Test** to verify the key and endpoint work — a sample title will appear.

## Configuration

| Field | Default | Notes |
|-------|---------|-------|
| API endpoint | `https://api.anthropic.com/v1/messages` | Use any OpenAI-compatible `/chat/completions` endpoint for other providers |
| Model | `claude-haiku-4-5-20251001` | Cheapest Haiku model is ideal; titles use ~50–100 tokens |
| API key | — | Stored in `~/.minder/secrets.json`, never exposed to the browser |

## Generating titles

On any session detail page, click **Generate title** in the top-right of the nav bar. The title is stored in the database and shown immediately. Click **Regenerate** to replace it.

## Cost

Each title generation uses roughly 50–100 output tokens. At Haiku 4.5 pricing this is approximately $0.0001 per session — negligible for personal use.

## Security

Your API key is stored in `~/.minder/secrets.json` with `chmod 0o600` on POSIX systems. On Windows the file inherits the `~/.minder/` directory ACL; see the [Terminal help page](terminal.md) for `icacls` hardening instructions.

## OpenAI-compatible endpoints

Set the endpoint to your provider's `/chat/completions` URL (e.g. `http://localhost:11434/v1/chat/completions` for Ollama). Project Minder auto-detects the Anthropic message format vs OpenAI format based on whether the URL contains `anthropic.com`.
