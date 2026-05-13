import type { UsageTurn } from "@/lib/usage/types";

// Shared `makeTurn(overrides)` factory. Several tests under tests/usage/
// (classifier, costCalculator, oneShotDetector, sessionQuality) used to
// roll their own near-identical helper. This file is the single source of
// defaults; per-test overrides remain via the `overrides` arg.
//
// `role` is required to keep call sites honest — the field has no
// universally correct default and the various detectors care about it
// (see sessionQuality's user/assistant split). Defaulting it would
// silently inject `"user"` into tests that meant to assert on assistant
// behavior.

const DEFAULTS: Omit<UsageTurn, "role"> = {
  timestamp: "2026-01-01T00:00:00Z",
  sessionId: "sess-1",
  projectSlug: "test-project",
  projectDirName: "test-project",
  model: "claude-sonnet-4-6",
  inputTokens: 0,
  outputTokens: 0,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  toolCalls: [],
};

export function makeTurn(
  overrides: Partial<UsageTurn> & { role: UsageTurn["role"] },
): UsageTurn {
  return { ...DEFAULTS, ...overrides };
}

/** Convenience for assistant turns — the most common shape. `role` is
 *  excluded from the overrides type so callers can't accidentally
 *  produce a user turn from this helper (the wrapper would otherwise
 *  silently honor the override after the spread). */
export function assistantTurn(overrides: Omit<Partial<UsageTurn>, "role"> = {}): UsageTurn {
  return makeTurn({ ...overrides, role: "assistant" });
}

/** Convenience for user turns. Same role-override guard as assistantTurn. */
export function userTurn(overrides: Omit<Partial<UsageTurn>, "role"> = {}): UsageTurn {
  return makeTurn({ ...overrides, role: "user" });
}

export function readTurn(
  path: string,
  sessionId = "sess-1",
  timestamp = "2026-01-01T00:00:00Z"
): UsageTurn {
  return assistantTurn({ sessionId, timestamp, toolCalls: [{ name: "Read", arguments: { file_path: path } }] });
}

export function editTurn(
  path: string,
  sessionId = "sess-1",
  timestamp = "2026-01-01T00:00:00Z"
): UsageTurn {
  return assistantTurn({ sessionId, timestamp, toolCalls: [{ name: "Edit", arguments: { file_path: path } }] });
}

export function mcpCallTurn(server: string, tool = "do"): UsageTurn {
  return assistantTurn({ toolCalls: [{ name: `mcp__${server}__${tool}` }] });
}
