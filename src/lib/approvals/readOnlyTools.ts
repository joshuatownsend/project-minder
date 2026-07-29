// Which tool calls may skip the approval gate entirely.
//
// The blocking approval hook adds a round-trip to every tool call Claude
// makes. For `Read`/`Grep`/`Glob` — which fire constantly and can't do
// anything — that latency buys nothing, so they pass straight through.
//
// **The polarity here is the whole safety property.** This is an
// allowlist, and anything not on it requires approval. A denylist would
// mean every tool added to Claude Code in future — and every tool on
// every MCP server the user connects — silently skips the gate, with
// nothing surfacing that it happened. So the default is "ask", and each
// bypass is an explicit, argued entry.

/**
 * Tools that neither mutate state nor send data anywhere.
 *
 * Deliberately NOT included, despite being commonly called:
 *
 * - `Bash` / `PowerShell` — can do anything at all, including `rm -rf`
 *   and `curl`. The single most important tool to gate.
 * - `WebFetch` / `WebSearch` — no local mutation, but they EGRESS. A URL
 *   can carry data out of the machine, so they are in scope for a gate
 *   whose purpose is "tell me before something consequential happens".
 *   This is a deliberate departure from claude-pulse, which passes all
 *   read-only tools through.
 * - `TodoWrite` — harmless in practice, but it is a write, and the
 *   allowlist is not the place to start making exceptions for writes.
 * - `Agent` / `Task` / `Skill` — dispatch arbitrary further tool calls.
 *   Gating the parent is the only way to gate what it spawns.
 * - Anything `mcp__*` — a third-party server with unknown side effects.
 *   `mcp__github__create_pull_request` looks like a read to a name-based
 *   heuristic and is not.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "TodoRead",
  "ReadMcpResourceTool",
  "ListMcpResourcesTool",
]);

/**
 * True when this tool call may bypass the approval gate.
 *
 * Matching is exact and case-sensitive: Claude Code emits stable
 * PascalCase tool names, and loose matching is how `Read` would come to
 * accept `ReadAndDelete`. An empty or non-string name is never
 * bypassable — a malformed payload must not become a free pass.
 */
export function isReadOnlyTool(toolName: string | null | undefined): boolean {
  if (typeof toolName !== "string" || !toolName) return false;
  // Belt and braces: an MCP tool can never be bypassed even if a name
  // collision ever put one in the set above.
  if (toolName.startsWith("mcp__")) return false;
  return READ_ONLY_TOOLS.has(toolName);
}

/** Exposed for tests and for the Settings UI that documents the list. */
export function readOnlyToolNames(): string[] {
  return [...READ_ONLY_TOOLS].sort();
}
