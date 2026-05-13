import type { UsageTurn } from "@/lib/usage/types";

export function makeTurn(
  overrides: Partial<UsageTurn> & { role: "user" | "assistant" }
): UsageTurn {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    sessionId: "s1",
    projectSlug: "p",
    projectDirName: "p",
    model: "claude-sonnet-4-6",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    ...overrides,
  };
}

export function assistant(overrides: Partial<UsageTurn> = {}): UsageTurn {
  return makeTurn({ role: "assistant", ...overrides });
}

export function user(overrides: Partial<UsageTurn> = {}): UsageTurn {
  return makeTurn({ role: "user", ...overrides });
}

export function readTurn(
  path: string,
  sessionId = "s1",
  timestamp = "2026-01-01T00:00:00Z"
): UsageTurn {
  return makeTurn({
    role: "assistant",
    sessionId,
    timestamp,
    toolCalls: [{ name: "Read", arguments: { file_path: path } }],
  });
}

export function editTurn(
  path: string,
  sessionId = "s1",
  timestamp = "2026-01-01T00:00:00Z"
): UsageTurn {
  return makeTurn({
    role: "assistant",
    sessionId,
    timestamp,
    toolCalls: [{ name: "Edit", arguments: { file_path: path } }],
  });
}

export function mcpCallTurn(server: string, tool = "do"): UsageTurn {
  return makeTurn({
    role: "assistant",
    toolCalls: [{ name: `mcp__${server}__${tool}` }],
  });
}
