// One-line human summary of a tool call, for the approval card.
//
// The user is being asked to approve something in a notification or a
// small card, so the summary has to answer "what is about to happen"
// without them opening anything. A JSON dump of `tool_input` does not.
//
// **Truncation is a safety feature, not just cosmetics.** These strings
// reach notification transports. A 40 KB `Write` payload or a
// base64-encoded blob in a notification body is at best useless and at
// worst a way to push a large amount of file content somewhere it wasn't
// meant to go, so every branch is length-capped.

/** Cap per summary. Long enough for a real command line, short enough for a card. */
const MAX_SUMMARY = 200;

function clamp(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_SUMMARY ? flat : flat.slice(0, MAX_SUMMARY - 1) + "…";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * Build the summary. Falls back to the tool name alone rather than
 * throwing or dumping JSON — an unrecognised tool still needs an
 * approvable description, and "unknown shape" must not become "no card".
 */
export function summarizeToolCall(toolName: string, rawInput: unknown): string {
  const input =
    rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};

  switch (toolName) {
    case "Bash":
    case "PowerShell": {
      // The command IS the decision for a shell call — show it verbatim
      // (clamped) rather than a description of it.
      const cmd = str(input.command);
      return cmd ? clamp(cmd) : "shell command";
    }
    case "Write": {
      const p = str(input.file_path);
      const content = str(input.content);
      const bytes = content ? `${content.length} chars` : "";
      // Deliberately NOT the content: it can be enormous, and the path
      // plus size is what makes the decision.
      return clamp(p ? `write ${p}${bytes ? ` (${bytes})` : ""}` : "write a file");
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const p = str(input.file_path);
      return clamp(p ? `edit ${p}` : "edit a file");
    }
    case "WebFetch": {
      const url = str(input.url);
      return clamp(url ? `fetch ${url}` : "fetch a URL");
    }
    case "WebSearch": {
      const q = str(input.query);
      return clamp(q ? `web search: ${q}` : "web search");
    }
    case "Agent":
    case "Task": {
      const t = str(input.subagent_type) ?? str(input.description);
      return clamp(t ? `run subagent: ${t}` : "run a subagent");
    }
    case "Skill": {
      const sk = str(input.skill) ?? str(input.command);
      return clamp(sk ? `run skill: ${sk}` : "run a skill");
    }
    default: {
      // MCP tools and anything unrecognised. Prefer the most
      // decision-relevant common field over a JSON dump; several of these
      // (`command`, `url`, `path`) recur across MCP servers.
      const guess =
        str(input.command) ??
        str(input.url) ??
        str(input.path) ??
        str(input.file_path) ??
        str(input.query) ??
        str(input.description);
      return clamp(guess ? `${toolName}: ${guess}` : toolName);
    }
  }
}
