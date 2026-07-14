# MCP server health

The **MCP strip** in the top bar shows a row of health dots — one per configured MCP server — so you can see at a glance whether your connected servers are actually **reachable**, not just configured. Click it for a per-server breakdown.

## What it shows

- A compact **`MCP` label + colored dots**, one per server: green = up, red = down, grey = unknown. When any server is down, an amber **`N down`** count appears next to the dots.
- **Clicking** opens a popover listing every server, sorted **problems first**, each with its name, **transport** and **source** chips, a status label, and the probe **detail** (e.g. `reachable (HTTP 200)`). A footer summarizes `up · down · unknown`.

The dots are hidden entirely until the first probe results land, so there's no empty flash on startup.

## What "health" means (it's honest per transport)

Health means different things depending on how a server is connected, and the popover never over-claims:

- **HTTP / SSE servers** get a **real reachability probe**. *Any* HTTP response — even `401`, `405`, or `406` — proves the server is listening, so it reads as **up**; only a connection failure or timeout is **down**. (The probe reads response headers and cancels the stream, so an SSE endpoint that holds its connection open still reads up quickly.)
- **stdio servers** can't be health-checked without *spawning* them, which would start the real server on every poll. So the signal is **launchability**: the command resolves on your `PATH` (and is executable on macOS/Linux) → **up**, tooltip *"launchable — not probed"*; missing or non-executable → **down**. A future opt-in will add a real handshake for stdio.
- **Disabled** servers and **unknown** transports show a neutral grey dot.

## Where the data comes from

The strip probes the **same merged user-scope MCP surface** the rest of Minder reads via `getUserConfig()` — servers from managed policy, `~/.claude/settings.json`, `~/.claude.json`, Claude Desktop, and installed plugins. Two servers that share a name across different sources are kept **distinct** (each gets its own dot).

Probes run in a small background cache with a **5-minute TTL** (mirroring the git/GitHub caches). The page polls `/api/mcp-health` every 15 seconds, speeding up to every 2 seconds while probes are still in flight.

### Freshness of the server list

The list of *which* servers exist comes from Minder's shared config cache. A server you **add or remove inside Minder** (Rescan, or any config write) refreshes immediately. A server you hand-edit into **`~/.claude.json` or `~/.claude/settings.json`** outside Minder is picked up **within seconds** — a background watcher invalidates the config cache when (and only when) the `mcpServers` block actually changes. Edits to the other sources (Claude Desktop, plugins, managed policy) surface within about **5 minutes** (the config-cache TTL).

## Turning it off

The strip is controlled by the **MCP server health** feature flag in **Settings**, which is **on by default**. Turning it off skips the background probes and hides the strip everywhere.
