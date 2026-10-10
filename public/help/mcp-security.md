# MCP Security Scanner

Project Minder automatically scans every configured MCP server for signs of prompt injection, credential harvesting, covert exfiltration, and other threat patterns. The scan runs in the background each time you trigger a rescan, and the results appear inline on the **Config → MCP** tab.

## How it works

The scanner analyses each server's static metadata — `command`, `args`, `url`, environment variable keys, and server name — without executing anything. Text is first run through an 8-pass deobfuscation pipeline (zero-width stripping, Unicode normalisation, base64 decoding, escape unescaping, and more) before pattern matching, so obfuscated payloads are still caught.

There are 59 pattern rules across 13 threat categories:

| Category | Code | Examples |
|---|---|---|
| Prompt Injection | PI | "ignore previous instructions", "you are now…", DAN mode |
| Credential Harvesting | CH | Hardcoded Bearer tokens, `sk-` keys, GitHub PATs |
| Tool Poisoning | TP | `process.exec`, `child_process.spawn`, dynamic Function constructor |
| Covert Exfiltration | CE | "exfiltrate to", POST credentials, read `.ssh/` |
| Deobfuscation Evasion | DE | `atob(`, base64 decode, Unicode escape chains |
| Shell Feature Abuse | SF | `; rm -rf`, `curl … \| sh` |
| Keylogger / Hook | HK | "keylogger", "hook keystrokes" |
| Dynamic Script | TS | Dynamic code evaluation, `vm.runInContext`, dynamic import |
| Command Injection | CI | Semicolon-chained dangerous commands, pipe to interpreter |
| Path Escape | PE | `../../etc/passwd`, UNC paths |
| Exfiltration Params | EP | Suspicious env key names: `api_key`, `password`, `token`, … |
| Sandbox Circumvention | SC | Sandbox bypass phrases |
| Cross-server Lateral | XR | References to calling another MCP server's tool |

## Severity levels

| Severity | Meaning |
|---|---|
| **crit** | Unambiguous malicious pattern (e.g. "ignore previous instructions") |
| **high** | Strong indicator requiring investigation |
| **med** | Moderately suspicious; common in legitimate tools too |
| **low** | Weak signal; context determines risk |
| **info** | Informational only |

## Reading the results

On the **Config → MCP** tab, each server row shows coloured severity chips (`crit`, `high`, `med`, `low`). Click a chip or the row to expand the findings list. Each finding shows:

- **Severity** — colour-coded badge
- **Rule ID** — e.g. `PI-01`
- **Surface** — where the match was found (`command`, `args`, `url`, `env`, `name`)
- **Message** — human-readable description
- **Evidence** — a short excerpt (truncated at 120 chars; secrets are never written to disk)

Servers that are toggled **disabled** are still scanned — a disabled server can be silently re-enabled, so the findings remain relevant.

## False positives

The scanner is tuned conservatively: `crit`/`high` are reserved for patterns with very low false-positive rates. Lower severities (`med`/`low`) may fire on legitimate developer commands (e.g. a `curl` in a build script). Use these as prompts to review, not automatic blocks.

## Feature flag

The **MCP security scan** feature flag (`Settings → Active features`) gates live tool-list introspection (coming in Wave 11.1b). The static-surface scan shown here always runs — it only inspects strings already in memory.

## What gets stored

Three tables are written to the local `~/.minder/index.db`:

- `mcp_scan_runs` — one row per scan with timing and server count
- `mcp_scan_findings` — one row per finding, linked to its run
- `mcp_tool_fingerprints` — SHA-256 hashes of tool descriptions for rug-pull detection (populated in Wave 11.1b)

Nothing is sent off-device.
